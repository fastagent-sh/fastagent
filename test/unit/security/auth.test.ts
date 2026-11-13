import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_AUTH_PATH, fastagentCredentialStore } from "../../../src/harnesses/models/credentials.ts";
import { modelEnvironment } from "../../../src/harnesses/models/environment.ts";

// Under this file's own empty HOME (test/setup.ts), never the machine's.
const GLOBAL = GLOBAL_AUTH_PATH;

afterEach(() => {
  rmSync(GLOBAL, { force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function authPath(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-auth-"));
  const path = join(dir, "auth.json");
  if (contents !== undefined) await writeFile(path, contents);
  return path;
}

describe("fastagentCredentialStore (read-write credential file; fail-visibly discipline)", () => {
  it("modify REFUSES to overwrite a corrupt file (never clobbers other providers' credentials)", async () => {
    const corrupt = '{ "anthropic": {"type":"oauth"}, CORRUPT';
    const path = await authPath(corrupt);
    const store = fastagentCredentialStore(path);
    await expect(store.modify("openai", async () => ({ type: "api_key", key: "sk" }))).rejects.toThrow(
      /corrupt auth file/,
    );
    expect(await readFile(path, "utf8")).toBe(corrupt); // file left intact for the user to fix
  });
});

describe("fastagentCredentialStore: the file carries the mode, the directory is the operator's", () => {
  it("writes 0600 into a 0755 directory and leaves that directory as it found it", async () => {
    // The line every comparable tool draws: Rails chmods the master.key it generates and leaves config/ alone;
    // the aws CLI ships a 0600 ~/.aws/config inside a 0755 ~/.aws. This used to chmod the directory 0700 on every
    // credential write — repairing a real bug by reaching into something fastagent did not create.
    const dir = await mkdtemp(join(tmpdir(), "fa-mode-"));
    await chmod(dir, 0o755);
    const file = join(dir, "auth.json");

    await fastagentCredentialStore(file).modify("anthropic", async () => ({ type: "api_key", key: "k" }));

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
  });
});

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
