// The credential layering every reader goes through: the agent's own file, then the user-global one per provider
// — unless a path was named (FASTAGENT_AUTH_PATH, FASTAGENT_SECRETS_DIR, or the `authPath` option), which is an
// instruction and gets no second layer.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_AUTH_PATH } from "../src/harnesses/models/credentials.ts";
import { modelEnvironment } from "../src/harnesses/models/environment.ts";

// Under this file's own empty HOME (test/setup.ts), never the machine's.
const GLOBAL = GLOBAL_AUTH_PATH;

function writeAuth(path: string, key: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ anthropic: { type: "api_key", key } }));
  return path;
}

/** The key a message of the agent in `dir` would send to anthropic, if any. */
async function anthropicKey(dir: string, environment: Record<string, string> = {}): Promise<string | undefined> {
  const { models } = await modelEnvironment(dir, {}, [], { environment });
  const model = models.getProvider("anthropic")?.getModels()[0];
  if (!model) throw new Error("pi-ai has no anthropic model");
  return (await models.getAuth(model))?.auth.apiKey;
}

const agentDir = () => mkdtempSync(join(tmpdir(), "fa-auth-layers-"));

afterEach(() => {
  rmSync(GLOBAL, { force: true });
  vi.unstubAllEnvs();
});

describe("an agent reads credentials through its layers", () => {
  it("falls back to the user-global file when nothing was named", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("FASTAGENT_AUTH_PATH", "");
    vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
    writeAuth(GLOBAL, "global-login");
    expect(await anthropicKey(agentDir())).toBe("global-login");
  });

  it("reads FASTAGENT_AUTH_PATH", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
    vi.stubEnv("FASTAGENT_AUTH_PATH", writeAuth(join(mkdtempSync(join(tmpdir(), "fa-named-")), "auth.json"), "named"));
    expect(await anthropicKey(agentDir())).toBe("named");
  });
});
