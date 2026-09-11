import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fastagentCredentialStore } from "../src/index.ts";

afterEach(() => vi.restoreAllMocks());

async function authPath(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-auth-"));
  const path = join(dir, "auth.json");
  if (contents !== undefined) await writeFile(path, contents);
  return path;
}

describe("fastagentCredentialStore (read-write credential file; fail-visibly discipline)", () => {
  it("missing file → undefined, no warning (normal not-configured)", async () => {
    const warn = vi.fn();
    expect(await fastagentCredentialStore("/nonexistent/auth.json", { warn }).read("anthropic")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("corrupt JSON → undefined, but warns (diagnosable root cause)", async () => {
    const path = await authPath("{not valid json");
    const warn = vi.fn();
    expect(await fastagentCredentialStore(path, { warn }).read("anthropic")).toBeUndefined();
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

  it("list returns metadata only, filtering foreign entries with read's validation", async () => {
    const oauth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 60_000 };
    const apiKey = { type: "api_key", key: "sk-x" };
    const path = await authPath(JSON.stringify({ anthropic: oauth, cloudflare: apiKey, old: { type: "legacy" } }));
    const infos = await fastagentCredentialStore(path).list();
    expect(infos).toEqual([
      { providerId: "anthropic", type: "oauth" },
      { providerId: "cloudflare", type: "api_key" },
    ]);
    for (const info of infos) expect(Object.keys(info).sort()).toEqual(["providerId", "type"]); // no secrets
  });

  it("list on a missing file → empty, no warning; corrupt file → empty + warns", async () => {
    const warn = vi.fn();
    expect(await fastagentCredentialStore("/nonexistent/auth.json", { warn }).list()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    const path = await authPath("{not valid json");
    expect(await fastagentCredentialStore(path, { warn }).list()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupt auth file"));
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

  it("structurally invalid roots (array/null/scalar) read as corrupt: read/list degrade + warn", async () => {
    for (const root of ["[]", "null", "42"]) {
      const warn = vi.fn();
      const path = await authPath(root);
      const store = fastagentCredentialStore(path, { warn });
      expect(await store.read("anthropic")).toBeUndefined();
      expect(await store.list()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupt auth file"));
    }
  });

  it("modify REFUSES structurally invalid roots (an array root would silently swallow the write)", async () => {
    for (const root of ["[]", "null", "42"]) {
      const path = await authPath(root);
      const store = fastagentCredentialStore(path);
      await expect(store.modify("anthropic", async () => ({ type: "api_key", key: "sk" }))).rejects.toThrow(
        /corrupt auth file/,
      );
      expect(await readFile(path, "utf8")).toBe(root); // file left intact for the user to fix
    }
  });

  it("concurrent modify on one absent file serializes under the lock; both first writes survive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-auth-"));
    const path = join(dir, "auth.json"); // does not exist yet: exercises init + lock together
    await Promise.all([
      fastagentCredentialStore(path).modify("anthropic", async () => ({ type: "api_key", key: "ka" })),
      fastagentCredentialStore(path).modify("openai", async () => ({ type: "api_key", key: "kb" })),
    ]);
    const creds = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(creds).sort()).toEqual(["anthropic", "openai"]);
  });

  it("two PROCESSES first-writing an absent file keep both providers (cross-process init + lock)", {
    timeout: 20_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-auth-mp-"));
    const path = join(dir, "auth.json");
    const authModule = fileURLToPath(new URL("../src/engines/pi/auth.ts", import.meta.url));
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

describe("fastagentCredentialStore: the global fallback layer", () => {
  const oauth = (access: string) => ({ type: "oauth" as const, access, refresh: "r", expires: Date.now() + 3_600_000 });
  const layered = async (project: Record<string, unknown>, global: Record<string, unknown>) => {
    const projectPath = await authPath(JSON.stringify(project));
    const globalPath = await authPath(JSON.stringify(global));
    return { projectPath, globalPath, store: fastagentCredentialStore(projectPath, { fallbackPath: globalPath }) };
  };

  it("falls back PER PROVIDER, so one project login does not hide the rest", async () => {
    // The reason this is not per FILE: `fastagent login anthropic` inside a project creates a project auth.json,
    // and a file-level fallback would make every other provider the person has globally disappear at that moment.
    const { store } = await layered(
      { anthropic: oauth("project") },
      { anthropic: oauth("global"), openai: oauth("g") },
    );
    const access = async (id: string) => {
      const credential = await store.read(id);
      return credential?.type === "oauth" ? credential.access : undefined;
    };
    expect(await access("anthropic")).toBe("project"); // the project's own wins
    expect(await access("openai")).toBe("g"); // still reachable
    expect((await store.list()).map((c) => c.providerId).sort()).toEqual(["anthropic", "openai"]);
  });

  it("writes a refresh back to the layer it was READ from", async () => {
    // Anything else conjures a second holder of the same OAuth grant — both providers rotate refresh tokens, so
    // whichever copy refreshes first invalidates the other.
    const { projectPath, globalPath, store } = await layered({ anthropic: oauth("project") }, { openai: oauth("g") });
    await store.modify("openai", async () => oauth("rotated"));
    expect(JSON.parse(await readFile(globalPath, "utf8")).openai.access).toBe("rotated");
    expect(JSON.parse(await readFile(projectPath, "utf8")).openai).toBeUndefined();

    await store.modify("anthropic", async () => oauth("rotated-too"));
    expect(JSON.parse(await readFile(projectPath, "utf8")).anthropic.access).toBe("rotated-too");
    expect(JSON.parse(await readFile(globalPath, "utf8")).anthropic).toBeUndefined();
  });

  it("a provider in neither layer is new, and belongs to the primary", async () => {
    const { projectPath, globalPath, store } = await layered({}, { openai: oauth("g") });
    await store.modify("anthropic", async () => oauth("fresh"));
    expect(JSON.parse(await readFile(projectPath, "utf8")).anthropic.access).toBe("fresh");
    expect(JSON.parse(await readFile(globalPath, "utf8")).anthropic).toBeUndefined();
  });

  it("deletes from the owning layer, and no fallback path means no second layer", async () => {
    const { projectPath, globalPath, store } = await layered({ anthropic: oauth("p") }, { openai: oauth("g") });
    await store.delete("openai");
    expect(JSON.parse(await readFile(globalPath, "utf8")).openai).toBeUndefined();

    // An explicitly named path is an instruction, not a preference: no layering at all.
    const plain = fastagentCredentialStore(projectPath);
    expect(await plain.read("openai")).toBeUndefined();
  });
});

describe("fastagentCredentialStore: the lock must be the one pi takes", () => {
  it("locks beside the PATH, not the symlink's target — pi-coding-agent uses realpath:false", async () => {
    // Verified against proper-lockfile: with `realpath: true` the lock lands beside the resolved file, so a
    // dotfile-managed auth.json (a symlink) gets TWO different lock files and `pi` and `fastagent` can both hold
    // one. They would then refresh the same provider concurrently, and a rotated refresh token logs one out.
    const target = await mkdtemp(join(tmpdir(), "fa-lock-target-"));
    const via = await mkdtemp(join(tmpdir(), "fa-lock-link-"));
    const real = join(target, "auth.json");
    const link = join(via, "auth.json");
    await writeFile(real, "{}");
    await symlink(real, link);

    let lockBesideLink = false;
    let lockBesideTarget = false;
    await fastagentCredentialStore(link).modify("anthropic", async () => {
      // Inside the callback the lock is held, so this is the only moment either file can be observed.
      lockBesideLink = existsSync(`${link}.lock`);
      lockBesideTarget = existsSync(`${real}.lock`);
      return { type: "api_key", key: "k" };
    });
    expect(lockBesideLink).toBe(true);
    expect(lockBesideTarget).toBe(false);

    // And the write goes THROUGH the link. A rename over the link would replace it with a regular file, after
    // which this tool and pi (which writes in place) would edit two different files — the same split one write
    // later, with the shared lock no longer meaning anything.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8")).anthropic.key).toBe("k");
  });

  it("a DANGLING symlink names where the credentials belong — it is followed, not replaced", async () => {
    // What a dotfile manager leaves before the target is checked out. `existsSync` sees through the link and says
    // no, but an exclusive create on it fails EEXIST, so the file never appears: resolving it with `realpathSync`
    // threw ENOENT and `login` dropped the grant it had just completed.
    const target = await mkdtemp(join(tmpdir(), "fa-dangle-target-"));
    const via = await mkdtemp(join(tmpdir(), "fa-dangle-link-"));
    const real = join(target, "nested", "auth.json"); // the directory does not exist yet either
    const link = join(via, "auth.json");
    await symlink(real, link);

    await fastagentCredentialStore(link).modify("anthropic", async () => ({ type: "api_key", key: "k" }));

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8")).anthropic.key).toBe("k");
    expect((await stat(dirname(real))).mode & 0o777).toBe(0o700); // the resolved dir owes the same repair
  });
});
