/**
 * A global login the environment shadows. The environment outranks the global credentials file for every agent
 * (docs/configuration.md#auth-and-secrets), so `fastagent login -g` for a provider an env variable already
 * authenticates stores a credential no agent uses. That must be said at login, not left to a startup line.
 *
 * The flow itself is interactive, so `loginFlow` is replaced by its result; everything after it is the real command.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentAuthSource } from "../src/engines/pi/models.ts";

vi.mock("../src/engines/pi/login.ts", async (original) => ({
  ...(await original<typeof import("../src/engines/pi/login.ts")>()),
  loginFlow: vi.fn(async () => ({ provider: "anthropic", method: "oauth", verified: "n/a" })),
}));
vi.mock("../src/cli/shared.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/shared.ts")>()),
  isInteractive: () => true,
  terminalLoginIO: () => ({}),
}));
// enterAgentEnv installs the proxy fetch, which swaps this process's fetch with no way back.
vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));

const { runLogin } = await import("../src/cli/commands/login.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Absent, not blank: an agent's `.env` only fills variables the process does not already have. */
function unsetAnthropicEnv(): void {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    vi.stubEnv(name, undefined);
}

/** stderr of one `fastagent login` run from `cwd`. */
async function login(cwd: string, global: boolean): Promise<string> {
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
  await runLogin(undefined, { global });
  return lines.join("\n");
}

describe("login: a global credential the environment shadows", () => {
  it("environmentAuthSource answers for the environment it is given, not for process.env", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-process");
    expect(await environmentAuthSource("anthropic", { ANTHROPIC_API_KEY: "sk-shell" })).toBe("ANTHROPIC_API_KEY");
    expect(await environmentAuthSource("anthropic", {})).toBeUndefined();
    expect(await environmentAuthSource("anthropic", { ANTHROPIC_API_KEY: " " })).toBeUndefined(); // blank is unset
  });

  it("warns after a global login the environment shadows, and only then", async () => {
    vi.stubEnv("FASTAGENT_AUTH_PATH", "");
    const outside = await mkdtemp(join(tmpdir(), "fa-login-global-"));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    expect(await login(outside, true)).toMatch(/warning: anthropic is also authenticated by ANTHROPIC_API_KEY/);

    // A project login is the project's own credential, which the environment does not outrank.
    const agent = join(await mkdtemp(join(tmpdir(), "fa-login-project-")), "fastagent");
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "fastagent.config.ts"), "export default {};\n");
    expect(await login(agent, false)).not.toMatch(/warning:/);

    // A key in ONE agent's value file is that agent's, not the machine's: `login` loads the file before it runs, and
    // a warning then would tell the owner to unset the deployment key `deploy` carries.
    unsetAnthropicEnv();
    await mkdir(join(agent, ".secrets"), { recursive: true });
    await writeFile(join(agent, ".secrets", ".env"), "ANTHROPIC_API_KEY=sk-agent-only\n");
    expect(await login(agent, true)).not.toMatch(/warning:/);
    // Outside an agent, `login` loads ~/.fastagent/.secrets/.env, which no agent reads at all. With nothing in the
    // shell, the global login is the one agents use.
    unsetAnthropicEnv(); // a fresh process: the previous run loaded the agent's `.env` into this one
    const machineSecrets = join(process.env.HOME as string, ".fastagent", ".secrets");
    await mkdir(machineSecrets, { recursive: true });
    await writeFile(join(machineSecrets, ".env"), "ANTHROPIC_API_KEY=sk-machine-home\n");
    expect(await login(outside, true)).not.toMatch(/warning:/);
  });
});
