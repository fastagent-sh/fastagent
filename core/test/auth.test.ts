import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piCredentialStore } from "../src/index.ts";

afterEach(() => vi.restoreAllMocks());

async function authFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-auth-"));
  const path = join(dir, "auth.json");
  await writeFile(path, contents);
  return path;
}

describe("piCredentialStore (read-only auth.json reader; fail-visibly discipline)", () => {
  it("missing file → undefined, no warning (normal not-configured)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cred = await piCredentialStore("/nonexistent/auth.json").read("anthropic");
    expect(cred).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("corrupt JSON → undefined, but warns (diagnosable root cause)", async () => {
    const path = await authFile("{not valid json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cred = await piCredentialStore(path).read("anthropic");
    expect(cred).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupt auth file"));
  });

  it("injected warn sink routes warnings to the injected logger without touching console", async () => {
    const path = await authFile("{not valid json");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const messages: string[] = [];
    const cred = await piCredentialStore(path, { warn: (m) => messages.push(m) }).read("anthropic");
    expect(cred).toBeUndefined();
    expect(messages[0]).toContain("corrupt auth file");
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("returns the stored oauth credential verbatim (upstream owns refresh/expiry)", async () => {
    const oauth = { type: "oauth", access: "tok-live", refresh: "r", expires: Date.now() + 60_000 };
    const path = await authFile(JSON.stringify({ anthropic: oauth }));
    expect(await piCredentialStore(path).read("anthropic")).toEqual(oauth);
  });

  it("returns api_key credentials (incl. provider-scoped env) — auth.json's other discriminator", async () => {
    const apiKey = { type: "api_key", key: "sk-x", env: { CLOUDFLARE_ACCOUNT_ID: "acc" } };
    const path = await authFile(JSON.stringify({ cloudflare: apiKey }));
    expect(await piCredentialStore(path).read("cloudflare")).toEqual(apiKey);
  });

  it("foreign/unknown discriminator reads as not-configured (does not crash resolution)", async () => {
    const path = await authFile(JSON.stringify({ anthropic: { type: "legacy", token: "x" } }));
    expect(await piCredentialStore(path).read("anthropic")).toBeUndefined();
  });

  it("missing provider entry → undefined", async () => {
    const path = await authFile(JSON.stringify({ openai: { type: "api_key", key: "sk" } }));
    expect(await piCredentialStore(path).read("anthropic")).toBeUndefined();
  });

  it("modify does NOT persist (pi CLI owns writes) but returns the function's result", async () => {
    const original = { anthropic: { type: "oauth", access: "old", expires: 1 } };
    const path = await authFile(JSON.stringify(original));
    const store = piCredentialStore(path);
    const next = { type: "oauth", access: "refreshed", refresh: "r", expires: 2 } as const;
    const result = await store.modify("anthropic", async () => next);
    expect(result).toEqual(next); // refreshed token is usable for the in-flight request
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original); // file untouched
  });

  it("delete is a no-op (read-only store)", async () => {
    const path = await authFile(JSON.stringify({ anthropic: { type: "oauth", access: "x", expires: 1 } }));
    const store = piCredentialStore(path);
    await expect(store.delete("anthropic")).resolves.toBeUndefined();
    expect(await store.read("anthropic")).toBeDefined(); // still there
  });
});
