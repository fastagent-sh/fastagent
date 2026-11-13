import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInProcess } from "./cli-run.ts";
import { CODEX_MODEL } from "./codex-model.ts";

// enterAgentEnv installs the proxy fetch, which swaps this process's fetch with no way back.
vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OAUTH = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };

/** An agent whose own credentials file holds `stored`. */
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

    // A login due a refresh is refreshed, as a message would; one the provider refuses is invalid, not missing.
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
