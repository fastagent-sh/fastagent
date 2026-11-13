import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, runInProcess, withRepoModules } from "../../doubles/cli-run.ts";
import { CODEX_MODEL } from "../../doubles/codex-model.ts";

// enterAgentEnv installs the proxy fetch, which swaps this process's fetch with no way back.
vi.mock("../../../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cli: login and models", () => {
  it("login OUTSIDE an agent announces the global credential — the scope switch is never silent", async () => {
    // Every other command refuses a non-agent dir; login has the one legitimate fallback (there is no
    // project credential to write). It must SAY so: the global file is not what dev/start in a real
    // agent would read, so a silent switch would strand the credential invisibly.
    const home = await mkdtemp(join(tmpdir(), "fa-login-global-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "fa-login-global-"));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.FASTAGENT_AUTH_PATH;
    const { code, stderr } = await runInProcess(["login", "no-such-provider"], cwd, env);
    expect(code).not.toBe(0);
    // The marker names itself, at both positions the lookup checks.
    expect(stderr).toMatch(/no agent here \(no fastagent\.config\.ts\)/);
    await expect(stat(join(cwd, ".secrets"))).rejects.toMatchObject({ code: "ENOENT" }); // nothing created in the non-agent dir

    // …and it is silent when FASTAGENT_AUTH_PATH outranks the fallback: an announcement naming a file the
    // run does not write would be worse than none.
    const directed = await runInProcess(["login", "no-such-provider"], cwd, {
      ...env,
      FASTAGENT_AUTH_PATH: join(cwd, "auth.json"),
    });
    expect(directed.stderr).not.toMatch(/logging in GLOBALLY/);

    // Standing INSIDE an agent is NOT "outside an agent" — findAgentDir refuses that position with
    // its own way out, and login must tell the same story as every other command instead of quietly
    // switching scope.
    const inside = join(cwd, "agent", "tools");
    await mkdir(inside, { recursive: true });
    await writeFile(join(cwd, "agent", "fastagent.config.ts"), "export default {};\n");
    const nested = await runInProcess(["login", "no-such-provider"], inside, env);
    expect(nested.stderr).toMatch(/is inside the agent .* — run from/);
    expect(nested.stderr).not.toMatch(/logging in GLOBALLY/);
  });

  it("models in an agent lists its definition's providers, without the secrets a serve needs", async () => {
    // A secret not filled in yet (`add telegram` writes none) stops dev and start; listing models must not need it.
    const dir = await agentWorkspace("fa-models-shape-", {
      "fastagent.config.ts":
        'import { fauxProvider } from "@earendil-works/pi-ai";\n' +
        "export default { providers: [{\n" +
        '  kind: "fastagent.needs", secrets: [{ name: "FA_TEST_GATEWAY_KEY", optional: false }],\n' +
        '  build: () => fauxProvider({ provider: "gw", models: [{ id: "m1" }] }).provider,\n' +
        "}] };\n",
    });
    await withRepoModules(dir);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.FA_TEST_GATEWAY_KEY;
    const listed = await runInProcess(["models", "gw/"], dir, env);
    expect([listed.code, listed.stdout.trim()], listed.stderr).toEqual([0, "gw/m1"]);
    const json = await runInProcess(["models", "gw/", "--json"], dir, env);
    expect(JSON.parse(json.stdout)).toEqual([{ spec: "gw/m1", provider: "gw", id: "m1", name: "m1" }]);
  });

  it("without a terminal, a choice not given is answered with the choices and a command for each (exit 2)", async () => {
    // runInProcess() pipes stdio, as a coding agent's shell does.
    const cwd = await agentWorkspace("fa-login-agent-");
    const unnamed = await runInProcess(["login"], cwd);
    expect(unnamed.code).toBe(2);
    expect(unnamed.stderr).toMatch(/name the provider to sign in to \(one of .*openai-codex.*\)/);
    const both = await runInProcess(["login", "OpenAI", "--json"], cwd);
    expect(both.code).toBe(2);
    expect(JSON.parse(both.stdout)).toMatchObject({
      status: "need_choice",
      message: "OpenAI signs in with an account or an API key: pass --method account or --method api-key",
      choices: [
        {
          provider: "openai",
          method: "account",
          label: "Sign in with ChatGPT",
          command: "fastagent login openai --method account --json",
        },
        { provider: "openai", method: "api-key", command: "fastagent login openai --method api-key --json" },
      ],
      agent_next_steps: expect.stringContaining("Ask the user which"),
    });
    expect((await runInProcess(["login", "openai", "--method", "key"], cwd)).stderr).toMatch(
      /--method must be account or api-key/,
    );
  });
});

const OAUTH = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };

async function agentHolding(stored: Record<string, unknown>): Promise<string> {
  const agent = join(await realpath(await mkdtemp(join(tmpdir(), "fa-auth-"))), "fastagent");
  await mkdir(join(agent, ".secrets"), { recursive: true });
  await writeFile(join(agent, "fastagent.config.ts"), "export default {};\n");
  await writeFile(join(agent, ".secrets", "auth.json"), JSON.stringify(stored));
  return agent;
}

describe("auth check: a provider's readiness, as pi's `auth check` answers a script", () => {
  it("ready, not_ready and invalid, exiting 0, 1 and 2", async () => {
    const agent = await agentHolding({
      "openai-codex": { ...OAUTH, refresh: "revoked", expires: 1 },
      "github-copilot": OAUTH,
    });
    const env = { ...process.env, ANTHROPIC_API_KEY: "sk-env", OPENAI_API_KEY: "" };
    const path = join(agent, ".secrets", "auth.json");

    const missingTarget = await runInProcess(["auth", "check"], agent, env);
    expect(missingTarget.code).toBe(2);
    expect(missingTarget.stderr).toContain("auth check needs --provider <id> or --model <provider/modelId>");

    const ready = await runInProcess(["auth", "check", "--provider", "anthropic"], agent, env);
    expect([ready.code, ready.stdout.trim()]).toEqual([0, "ready"]);

    const readyJson = await runInProcess(["auth", "check", "--provider", "anthropic", "--json"], agent, env);
    expect(readyJson.code).toBe(0);
    expect(JSON.parse(readyJson.stdout)).toEqual({
      status: "ready",
      provider: "anthropic",
      authType: "api_key",
      source: "ANTHROPIC_API_KEY",
      path,
    });

    const oauth = await runInProcess(["auth", "check", "--provider", "github-copilot", "--json"], agent, env);
    expect(oauth.code).toBe(0);
    expect(JSON.parse(oauth.stdout)).toMatchObject({ status: "ready", authType: "oauth", source: "OAuth" });

    const missing = await runInProcess(["auth", "check", "--provider", "openai", "--json"], agent, env);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({
      status: "not_ready",
      provider: "openai",
      reason: "credentials_not_configured",
      path,
    });

    const unknown = await runInProcess(["auth", "check", "--provider", "nope", "--json"], agent, env);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.stdout)).toEqual({
      status: "not_ready",
      provider: "nope",
      reason: "provider_not_found",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 401 })),
    );
    const refused = await runInProcess(["auth", "check", "--model", CODEX_MODEL, "--json"], agent, env);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      status: "invalid",
      provider: "openai-codex",
      reason: "invalid_state",
      error: expect.stringContaining("401"),
    });
  });
});

describe("logout: removing what login stored, as pi's /logout does", () => {
  it("removes the provider named by its id or name, and refuses an omitted provider without a terminal", async () => {
    const agent = await agentHolding({ "openai-codex": OAUTH, anthropic: { type: "api_key", key: "sk" } });
    const unnamed = await runInProcess(["logout"], agent);
    expect(unnamed.code).toBe(2);
    expect(unnamed.stderr).toContain("name the provider to log out of:");

    const first = await runInProcess(["logout", "OpenAI Codex"], agent);
    const second = await runInProcess(["logout", "anthropic"], agent);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(agent, ".secrets", "auth.json"), "utf8"))).toEqual({});
    expect(`${first.stderr}${second.stderr}`).toBe(
      `[fastagent] logged out of OpenAI Codex — removed from ${join(agent, ".secrets", "auth.json")}\n` +
        `[fastagent] removed the stored API key for Anthropic from ${join(agent, ".secrets", "auth.json")}; ` +
        "environment variables are unchanged\n",
    );
  });
});
