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
  it("environmentAuthSource names the variable that authenticates a provider, and nothing when none does", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    expect(await environmentAuthSource("anthropic")).toBe("ANTHROPIC_API_KEY");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    expect(await environmentAuthSource("anthropic")).toBeUndefined();
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

    // Nothing in the environment: the global login is the one agents use.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    expect(await login(outside, true)).not.toMatch(/warning:/);
  });
});
