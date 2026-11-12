import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

afterEach(() => vi.restoreAllMocks());

describe("fastagentCredentialStore (read-write credential file; fail-visibly discipline)", () => {
  it("two PROCESSES first-writing an absent file keep both providers (cross-process init + lock)", {
    timeout: 20_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-auth-mp-"));
    const path = join(dir, "auth.json");
    const authModule = fileURLToPath(new URL("../src/harnesses/models/credentials.ts", import.meta.url));
    const script = join(dir, "write.mjs");
    await writeFile(
      script,
      `import { fastagentCredentialStore } from ${JSON.stringify(authModule)};\n` +
        `const [path, provider] = process.argv.slice(2);\n` +
        `await fastagentCredentialStore(path).modify(provider, async () => ({ type: "api_key", key: provider }));\n`,
    );
    const run = (provider: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, path, provider], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`))));
      });
    await Promise.all([run("anthropic"), run("openai")]);
    const creds = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(creds).sort()).toEqual(["anthropic", "openai"]);
  });
});
