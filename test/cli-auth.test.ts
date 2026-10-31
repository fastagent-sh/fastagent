import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuthCheck } from "../src/cli/commands/auth.ts";
import { runLogout } from "../src/cli/commands/logout.ts";
import { CODEX_MODEL } from "./codex-model.ts";

// enterAgentEnv installs the proxy fetch, which swaps this process's fetch with no way back.
vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const OAUTH = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };

/** An agent whose own credentials file holds `stored`, run from: the command reads it as `cwd`. */
async function agentHolding(stored: Record<string, unknown>): Promise<string> {
  const agent = join(await mkdtemp(join(tmpdir(), "fa-auth-")), "fastagent");
  await mkdir(join(agent, ".secrets"), { recursive: true });
  await writeFile(join(agent, "fastagent.config.ts"), "export default {};\n");
  await writeFile(join(agent, ".secrets", "auth.json"), JSON.stringify(stored));
  vi.spyOn(process, "cwd").mockReturnValue(agent);
  return agent;
}

/** One run's stdout, and its exit code. */
async function checked(opts: Parameters<typeof runAuthCheck>[0]): Promise<{ out: string; code: unknown }> {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  await runAuthCheck(opts);
  return { out: out.join("\n"), code: process.exitCode };
}

describe("auth check: a provider's readiness, as pi's `auth check` answers a script", () => {
  it("ready, not_ready and invalid, exiting 0, 1 and 2", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    vi.stubEnv("OPENAI_API_KEY", "");
    const agent = await agentHolding({
      "openai-codex": { ...OAUTH, refresh: "revoked", expires: 1 },
      "github-copilot": OAUTH,
    });
    const path = join(agent, ".secrets", "auth.json");
    expect(await checked({ provider: "anthropic" })).toEqual({ out: "ready", code: 0 });
    expect(JSON.parse((await checked({ provider: "anthropic", json: true })).out)).toEqual({
      status: "ready",
      provider: "anthropic",
      authType: "api_key",
      source: "ANTHROPIC_API_KEY",
      path,
    });
    expect(JSON.parse((await checked({ provider: "github-copilot", json: true })).out)).toMatchObject({
      status: "ready",
      authType: "oauth",
      source: "OAuth",
    });
    expect(await checked({ provider: "openai", json: true })).toEqual({
      out: JSON.stringify({ status: "not_ready", provider: "openai", reason: "credentials_not_configured", path }),
      code: 1,
    });
    expect(await checked({ provider: "nope", json: true })).toEqual({
      out: JSON.stringify({ status: "not_ready", provider: "nope", reason: "provider_not_found" }),
      code: 1,
    });
    // A login due a refresh is refreshed, as a message would; one the provider refuses is invalid, not missing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 401 })),
    );
    const refused = await checked({ model: CODEX_MODEL, json: true });
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.out)).toMatchObject({
      status: "invalid",
      provider: "openai-codex",
      reason: "invalid_state",
      error: expect.stringContaining("401"),
    });
  });
});

describe("logout: removing what login stored, as pi's /logout does", () => {
  it("removes the provider named by its id or name, and only what is stored", async () => {
    const agent = await agentHolding({ "openai-codex": OAUTH, anthropic: { type: "api_key", key: "sk" } });
    const said: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void said.push(String(line)));
    await runLogout("OpenAI Codex (legacy)", {});
    await runLogout("anthropic", {});
    expect(JSON.parse(await readFile(join(agent, ".secrets", "auth.json"), "utf8"))).toEqual({});
    expect(said).toEqual([
      `[fastagent] logged out of OpenAI Codex (legacy) — removed from ${join(agent, ".secrets", "auth.json")}`,
      `[fastagent] removed the stored API key for Anthropic from ${join(agent, ".secrets", "auth.json")}; ` +
        "environment variables are unchanged",
    ]);
  });

  it("without a terminal, names what it holds when the provider is missing or not stored", async () => {
    await agentHolding({ "openai-codex": OAUTH });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...line: unknown[]) => void errors.push(line.join(" ")));
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await expect(runLogout(undefined, { input: false })).rejects.toThrow("exit 2");
    expect(errors.at(-1)).toMatch(/name the provider to log out of: it holds openai-codex/);
    await expect(runLogout("openai", {})).rejects.toThrow("exit 1");
    expect(errors.at(-1)).toMatch(/no credential for "openai" is stored in .*: it holds openai-codex/);
  });
});
