// The credential layering every rung reads through: the agent's own file, then the user-global one per provider
// — unless a path was named (FASTAGENT_AUTH_PATH, FASTAGENT_SECRETS_DIR, or the `authPath` option), which is an
// instruction and gets no second layer.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GLOBAL_AUTH_PATH } from "../src/engines/pi/auth.ts";
import { assemblePiFromDefinition } from "../src/engines/pi/create.ts";
import { probeAuthSource } from "../src/engines/pi/models.ts";

const SPEC = "fa-layer/m1";
const credential = { "fa-layer": { type: "api_key", key: "sk-test" } };

/** An agent dir whose models.json declares a keyless custom provider, so a stored credential is its only auth. */
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fa-auth-layers-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "fa-layer": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "m1" }] },
      },
    }),
  );
  return dir;
}

function writeAuth(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(credential));
  return path;
}

// Under this file's own empty HOME (test/setup.ts), never the machine's.
const GLOBAL = GLOBAL_AUTH_PATH;

/** Where L2 (`createPiAgentFromDefinition`'s assembly) found the credential, if anywhere. */
async function l2AuthSource(dir: string): Promise<string | undefined> {
  const { assembly } = await assemblePiFromDefinition(dir, { model: SPEC });
  return probeAuthSource((await assembly.engine()).modelRuntime, SPEC);
}

const saved = { auth: process.env.FASTAGENT_AUTH_PATH, secrets: process.env.FASTAGENT_SECRETS_DIR };
afterEach(() => {
  rmSync(GLOBAL, { force: true });
  for (const [key, value] of [
    ["FASTAGENT_AUTH_PATH", saved.auth],
    ["FASTAGENT_SECRETS_DIR", saved.secrets],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("L2 reads credentials through the same layers as the opener", () => {
  it("falls back to the user-global file when nothing was named", async () => {
    delete process.env.FASTAGENT_AUTH_PATH;
    delete process.env.FASTAGENT_SECRETS_DIR;
    writeAuth(GLOBAL);
    expect(await l2AuthSource(agentDir())).toBeDefined();
  });

  it("reads FASTAGENT_AUTH_PATH", async () => {
    delete process.env.FASTAGENT_SECRETS_DIR;
    process.env.FASTAGENT_AUTH_PATH = writeAuth(join(mkdtempSync(join(tmpdir(), "fa-named-")), "auth.json"));
    expect(await l2AuthSource(agentDir())).toBeDefined();
  });

  it("does NOT fall back to the global file under FASTAGENT_SECRETS_DIR (a deployed box reads its mount only)", async () => {
    delete process.env.FASTAGENT_AUTH_PATH;
    process.env.FASTAGENT_SECRETS_DIR = mkdtempSync(join(tmpdir(), "fa-mounted-secrets-"));
    writeAuth(GLOBAL);
    expect(await l2AuthSource(agentDir())).toBeUndefined();
  });
});
