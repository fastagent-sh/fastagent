import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthLoginCallbacks, Credential, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { fastagentCredentialStore } from "../src/engines/pi/auth.ts";
import type { IoOption, LoginIO } from "../src/engines/pi/login.ts";
import { loginFlow } from "../src/engines/pi/login.ts";

// The store is the REAL fastagentCredentialStore over a temp file — the same writer the runtime uses,
// so these tests exercise the actual persist/corruption semantics. Only the providers' login flow
// (external) is injected via fake providers; pi's unified ProviderAuth shape is what loginFlow drives.
async function tmpAuth(content?: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fa-login-")), "auth.json");
  if (content !== undefined) await writeFile(path, content);
  return path;
}
const readAuth = async (path: string) => JSON.parse(await readFile(path, "utf8"));

const OAUTH_CRED: Credential = { type: "oauth", access: "tok", refresh: "rt", expires: Date.now() + 3_600_000 };

/** A fake provider: an oauth login returning a fixed credential, and/or an api-key login that prompts. */
function fakeProvider(
  id: string,
  opts: { oauth?: boolean; apiKeyLogin?: boolean; onOauthLogin?: (cb: AuthLoginCallbacks) => Promise<Credential> } = {},
): Provider {
  return {
    id,
    name: id,
    auth: {
      oauth: opts.oauth ? { name: `${id} (OAuth)`, login: opts.onOauthLogin ?? (async () => OAUTH_CRED) } : undefined,
      apiKey: opts.apiKeyLogin
        ? {
            name: `${id} API key`,
            login: async (cb: AuthLoginCallbacks): Promise<Credential> => ({
              type: "api_key",
              key: await cb.prompt({ type: "secret", message: "API key" }),
            }),
          }
        : undefined,
    },
  } as unknown as Provider;
}

const PROVIDERS = [
  fakeProvider("anthropic", { oauth: true, apiKeyLogin: true }), // both methods
  fakeProvider("openai", { apiKeyLogin: true }), // key only
  fakeProvider("codex", { oauth: true }), // oauth only
];

/** Scripted terminal: `select`/`prompt` answers in order; records the options shown to each `select`. */
function fakeIO(script: { select?: Array<string | undefined>; prompt?: Array<string | undefined> } = {}) {
  const selects = [...(script.select ?? [])];
  const prompts = [...(script.prompt ?? [])];
  const shown: IoOption[][] = [];
  const io: LoginIO = {
    select: async (_message, options) => {
      shown.push(options);
      return selects.shift();
    },
    prompt: async () => prompts.shift(),
    note: () => {},
    openUrl: () => {},
  };
  return { io, shown };
}

describe("loginFlow", () => {
  it("a single-method provider auto-runs that method (oauth) and persists {type:oauth}", async () => {
    const path = await tmpAuth();
    const res = await loginFlow(fakeIO().io, {
      provider: "codex",
      providers: PROVIDERS,
      store: fastagentCredentialStore(path),
    });
    expect(res).toEqual({ provider: "codex", method: "oauth" });
    expect((await readAuth(path)).codex).toMatchObject({ type: "oauth", access: "tok" });
  });

  it("an api-key provider prompts (hidden) and persists {type:api_key}", async () => {
    const path = await tmpAuth();
    const res = await loginFlow(fakeIO({ prompt: ["sk-123"] }).io, {
      provider: "openai",
      providers: PROVIDERS,
      store: fastagentCredentialStore(path),
    });
    expect(res).toEqual({ provider: "openai", method: "api_key" });
    expect((await readAuth(path)).openai).toEqual({ type: "api_key", key: "sk-123" });
  });

  it("a dual-method provider asks which method, then runs it", async () => {
    const path = await tmpAuth();
    const res = await loginFlow(fakeIO({ select: ["api_key"], prompt: ["sk-a"] }).io, {
      provider: "anthropic",
      providers: PROVIDERS,
      store: fastagentCredentialStore(path),
    });
    expect(res).toEqual({ provider: "anthropic", method: "api_key" });
    expect((await readAuth(path)).anthropic).toEqual({ type: "api_key", key: "sk-a" });
  });

  it("no args → method select then provider select (filtered to that method)", async () => {
    const path = await tmpAuth();
    const { io, shown } = fakeIO({ select: ["oauth", "anthropic"] });
    const res = await loginFlow(io, { providers: PROVIDERS, store: fastagentCredentialStore(path) });
    expect(res).toEqual({ provider: "anthropic", method: "oauth" });
    // the provider picker listed only oauth-capable providers (anthropic, codex), NOT the key-only openai
    expect(shown[1]?.map((o) => o.value).sort()).toEqual(["anthropic", "codex"]);
  });

  it("the provider picker shows configured status from the store", async () => {
    const path = await tmpAuth();
    const store = fastagentCredentialStore(path);
    await store.modify("anthropic", async () => OAUTH_CRED); // pre-configure
    const { io, shown } = fakeIO({ select: ["oauth", "codex"] });
    await loginFlow(io, { providers: PROVIDERS, store });
    expect(shown[1]?.find((o) => o.value === "anthropic")?.hint).toMatch(/configured \(oauth\)/);
    expect(shown[1]?.find((o) => o.value === "codex")?.hint).toBeUndefined(); // unconfigured
  });

  it("an empty provider selection fails visibly", async () => {
    await expect(
      loginFlow(fakeIO({ select: ["oauth", undefined] }).io, {
        providers: PROVIDERS,
        store: fastagentCredentialStore(await tmpAuth()),
      }),
    ).rejects.toThrow(/no provider selected/);
  });

  it("an empty API key fails visibly and persists no credential", async () => {
    const path = await tmpAuth();
    await expect(
      loginFlow(fakeIO({ prompt: [undefined] }).io, {
        provider: "openai",
        providers: PROVIDERS,
        store: fastagentCredentialStore(path),
      }),
    ).rejects.toThrow(/cancelled/);
    expect((await readAuth(path).catch(() => ({}))).openai).toBeUndefined();
  });

  it("a corrupt auth file fails up front (preflight), before the provider flow runs", async () => {
    const path = await tmpAuth("{ not valid json");
    let ran = false;
    const providers = [
      fakeProvider("codex", {
        oauth: true,
        onOauthLogin: async () => {
          ran = true;
          return OAUTH_CRED;
        },
      }),
    ];
    await expect(
      loginFlow(fakeIO().io, { provider: "codex", providers, store: fastagentCredentialStore(path) }),
    ).rejects.toThrow(/corrupt auth file/);
    expect(ran).toBe(false); // preflight threw before the flow — no wasted round-trip
  });

  // #58 invariant: the persist write AFTER a successful flow must fail visibly, never a false success.
  // A read-only (0444) file lets the preflight pass (read + lock, no write) and the flow run, then the
  // persist write hits EACCES. (Skipped under root, which bypasses the permission check.)
  it.skipIf(process.getuid?.() === 0)(
    "a persist write failure after a successful flow rejects, persisting nothing",
    async () => {
      const path = await tmpAuth(JSON.stringify({ existing: { type: "api_key", key: "x" } }));
      await chmod(path, 0o444);
      let ran = false;
      const providers = [
        fakeProvider("codex", {
          oauth: true,
          onOauthLogin: async () => {
            ran = true;
            return OAUTH_CRED;
          },
        }),
      ];
      await expect(
        loginFlow(fakeIO().io, { provider: "codex", providers, store: fastagentCredentialStore(path) }),
      ).rejects.toThrow(/EACCES|permission/i);
      expect(ran).toBe(true); // got past preflight + flow; only the persist write failed
      expect((await readAuth(path)).codex).toBeUndefined(); // no false success
    },
  );

  it("a prompt the provider leaves pending is aborted when the flow resolves, so the CLI does not hang", async () => {
    let aborted = false;
    const io: LoginIO = {
      select: async () => undefined,
      prompt: (_m, opts) =>
        new Promise<string>((_res, rej) => {
          opts?.signal?.addEventListener("abort", () => {
            aborted = true;
            rej(new Error("aborted"));
          });
        }),
      note: () => {},
      openUrl: () => {},
    };
    const providers = [
      fakeProvider("codex", {
        oauth: true,
        onOauthLogin: async (cb) => {
          void cb.prompt({ type: "manual_code", message: "paste" }).catch(() => {}); // pending, never awaited
          return OAUTH_CRED;
        },
      }),
    ];
    await expect(
      loginFlow(io, { provider: "codex", providers, store: fastagentCredentialStore(await tmpAuth()) }),
    ).resolves.toEqual({ provider: "codex", method: "oauth" });
    expect(aborted).toBe(true); // `done` backstop cancelled the pending prompt
  });
});
