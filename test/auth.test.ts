import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastagentCredentialStore } from "../src/harnesses/models/credentials.ts";

afterEach(() => vi.restoreAllMocks());

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
