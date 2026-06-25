import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastagentCredentialStore } from "../src/index.ts";

afterEach(() => vi.restoreAllMocks());

async function authPath(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-auth-"));
  const path = join(dir, "auth.json");
  if (contents !== undefined) await writeFile(path, contents);
  return path;
}

describe("fastagentCredentialStore (read-write ~/.fastagent/auth.json; fail-visibly discipline)", () => {
  it("missing file → undefined, no warning (normal not-configured)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await fastagentCredentialStore("/nonexistent/auth.json").read("anthropic")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("corrupt JSON → undefined, but warns (diagnosable root cause)", async () => {
    const path = await authPath("{not valid json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await fastagentCredentialStore(path).read("anthropic")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupt auth file"));
  });

  it("injected warn sink routes warnings to the injected logger without touching console", async () => {
    const path = await authPath("{not valid json");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const messages: string[] = [];
    await fastagentCredentialStore(path, { warn: (m: string) => messages.push(m) }).read("anthropic");
    expect(messages[0]).toContain("corrupt auth file");
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("reads stored oauth + api_key verbatim; foreign/missing read as not-configured", async () => {
    const oauth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 60_000 };
    const apiKey = { type: "api_key", key: "sk-x", env: { CLOUDFLARE_ACCOUNT_ID: "acc" } };
    const path = await authPath(JSON.stringify({ anthropic: oauth, cloudflare: apiKey, old: { type: "legacy" } }));
    const store = fastagentCredentialStore(path);
    expect(await store.read("anthropic")).toEqual(oauth);
    expect(await store.read("cloudflare")).toEqual(apiKey);
    expect(await store.read("old")).toBeUndefined(); // foreign discriminator
    expect(await store.read("openai")).toBeUndefined(); // missing entry
  });

  it("modify PERSISTS the refreshed credential (the rotation write a read-only store would lose)", async () => {
    const path = await authPath(
      JSON.stringify({ anthropic: { type: "oauth", access: "old", refresh: "r0", expires: 1 } }),
    );
    const store = fastagentCredentialStore(path);
    const refreshed = { type: "oauth", access: "new", refresh: "r1", expires: 2 } as const;
    const result = await store.modify("anthropic", async (current) => {
      expect((current as { access?: string } | undefined)?.access).toBe("old"); // fn sees the current credential
      return refreshed;
    });
    expect(result).toEqual(refreshed);
    expect(await store.read("anthropic")).toEqual(refreshed); // a later read / a restart sees the rotated token
    expect(JSON.parse(await readFile(path, "utf8")).anthropic).toEqual(refreshed);
  });

  it("modify returning undefined leaves the entry unchanged (no write)", async () => {
    const cred = { type: "oauth", access: "x", refresh: "r", expires: 9 };
    const path = await authPath(JSON.stringify({ anthropic: cred }));
    const store = fastagentCredentialStore(path);
    expect(await store.modify("anthropic", async () => undefined)).toEqual(cred);
    expect(await store.read("anthropic")).toEqual(cred);
  });

  it("modify creates the file when absent (a first login into a fresh ~/.fastagent)", async () => {
    const path = await authPath(); // no file yet
    const store = fastagentCredentialStore(path);
    const cred = { type: "api_key", key: "sk-new" } as const;
    await store.modify("openai", async () => cred);
    expect(await store.read("openai")).toEqual(cred);
  });

  it("delete removes the entry (logout), leaving others intact", async () => {
    const path = await authPath(
      JSON.stringify({ anthropic: { type: "oauth", access: "x", expires: 1 }, openai: { type: "api_key", key: "k" } }),
    );
    const store = fastagentCredentialStore(path);
    await store.delete("anthropic");
    expect(await store.read("anthropic")).toBeUndefined();
    expect(await store.read("openai")).toBeDefined();
  });

  it("modify REFUSES to overwrite a corrupt file (never clobbers other providers' credentials)", async () => {
    const corrupt = '{ "anthropic": {"type":"oauth"}, CORRUPT';
    const path = await authPath(corrupt);
    const store = fastagentCredentialStore(path);
    await expect(store.modify("openai", async () => ({ type: "api_key", key: "sk" }))).rejects.toThrow(
      /corrupt auth file/,
    );
    expect(await readFile(path, "utf8")).toBe(corrupt); // file left intact for the user to fix
  });

  it("delete of a missing entry / file is a no-op that does not create the file", async () => {
    const missing = await authPath(); // no file at all
    await fastagentCredentialStore(missing).delete("anthropic");
    expect(existsSync(missing)).toBe(false); // not created

    const present = await authPath(JSON.stringify({ openai: { type: "api_key", key: "k" } }));
    const before = await readFile(present, "utf8");
    await fastagentCredentialStore(present).delete("anthropic"); // provider absent
    expect(await readFile(present, "utf8")).toBe(before); // unchanged (no write)
  });
});
