/**
 * `availableModelsFromDir`: what an embedding client's model picker can offer for an agent directory.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { availableModelsFromDir, createPiAgentFromDir } from "../src/engines/pi/open.ts";

/** A workspace whose agent sits one level inside, with no model set and two custom endpoints. */
async function workspace(auth: string): Promise<{ dir: string; authPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fa-available-"));
  const agent = join(dir, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "fastagent.config.ts"), "export default {};");
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        // Keyless local server: pi's docs prescribe a literal placeholder key.
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          apiKey: "ollama",
          models: [{ id: "llama" }],
        },
        // Its key comes from an environment variable that is not set.
        gated: {
          baseUrl: "http://gw.invalid/v1",
          api: "openai-completions",
          apiKey: "$FA_AVAILABLE_TEST_UNSET_KEY",
          models: [{ id: "x" }],
        },
      },
    }),
  );
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, auth);
  return { dir, authPath };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("availableModelsFromDir", () => {
  it("lists what the agent can run now: configured endpoints and stored logins, nothing refreshed", async () => {
    // Only the stored login can list anthropic here, whatever this machine's environment holds.
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", undefined);
    const expiredOAuth = { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } };
    const { dir, authPath } = await workspace(JSON.stringify(expiredOAuth));
    const fetch = vi.spyOn(globalThis, "fetch");

    const specs = await availableModelsFromDir(dir, { authPath });

    expect(specs).toContain("local/llama");
    expect(specs).not.toContain("gated/x");
    expect(specs.some((spec) => spec.startsWith("anthropic/"))).toBe(true); // an expired login is still configured
    expect(fetch).not.toHaveBeenCalled(); // no token refresh, no provider call
    expect(specs).toEqual([...specs].sort());
  });

  it("a listed spec is one the opener runs with", async () => {
    const { dir, authPath } = await workspace("{}");
    const [spec] = (await availableModelsFromDir(dir, { authPath })).filter((s) => s.startsWith("local/"));
    expect(spec).toBe("local/llama");

    const opened = await createPiAgentFromDir(dir, { model: spec, authPath });
    expect(opened.modelSpec).toBe("local/llama");
  });

  it("a corrupt credentials file reaches a throwing warn instead of reading as nothing configured", async () => {
    const { dir, authPath } = await workspace("{ not json");
    await expect(
      availableModelsFromDir(dir, {
        authPath,
        warn: (message) => {
          throw new Error(`credentials: ${message}`);
        },
      }),
    ).rejects.toThrow(/credentials:/);
  });
});
