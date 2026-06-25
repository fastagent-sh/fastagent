import { AuthStorage, InMemoryAuthStorageBackend } from "@earendil-works/pi-coding-agent";
import type { AuthStorageBackend } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AuthStore, LoginIO } from "../src/engines/pi/login.ts";
import { loginFlow } from "../src/engines/pi/login.ts";

/** A fake AuthStore for the ROUTING tests (anthropic/openai-codex are OAuth-capable); persistence ok. */
function fakeStore() {
  const calls: { login?: string; set?: [string, { type: string; key: string }] } = {};
  const store: AuthStore = {
    getOAuthProviders: () => [
      { id: "anthropic", name: "Anthropic (Claude Pro/Max)" },
      { id: "openai-codex", name: "ChatGPT Codex" },
    ],
    login: async (providerId) => {
      calls.login = providerId;
    },
    set: (provider, credential) => {
      calls.set = [provider, credential];
    },
    drainErrors: () => [],
  };
  return { store, calls };
}

/** A fake terminal: scripted prompt/hidden answers, captured prints, no real stdin/browser. */
function fakeIO(answers: { prompt?: string[]; hidden?: string[] } = {}) {
  const printed: string[] = [];
  const prompts = [...(answers.prompt ?? [])];
  const hiddens = [...(answers.hidden ?? [])];
  const io: LoginIO = {
    print: (l) => printed.push(l),
    prompt: async () => prompts.shift() ?? "",
    promptHidden: async () => hiddens.shift() ?? "",
    openUrl: () => {},
  };
  return { io, printed };
}

describe("loginFlow", () => {
  it("an OAuth-capable provider runs the login flow (no api_key write)", async () => {
    const { store, calls } = fakeStore();
    const res = await loginFlow(fakeIO().io, { provider: "anthropic", store });
    expect(res).toEqual({ provider: "anthropic", method: "oauth" });
    expect(calls.login).toBe("anthropic");
    expect(calls.set).toBeUndefined();
  });

  it("any other provider prompts (hidden) for and stores an API key (no OAuth)", async () => {
    const { store, calls } = fakeStore();
    const res = await loginFlow(fakeIO({ hidden: ["sk-123"] }).io, { provider: "openai", store });
    expect(res).toEqual({ provider: "openai", method: "api_key" });
    expect(calls.set).toEqual(["openai", { type: "api_key", key: "sk-123" }]);
    expect(calls.login).toBeUndefined();
  });

  it("no provider → interactive select among the OAuth providers (by number or id)", async () => {
    const byNumber = await loginFlow(fakeIO({ prompt: ["2"] }).io, { store: fakeStore().store });
    expect(byNumber.provider).toBe("openai-codex");
    const byId = await loginFlow(fakeIO({ prompt: ["anthropic"] }).io, { store: fakeStore().store });
    expect(byId.provider).toBe("anthropic");
  });

  it("an empty selection fails visibly", async () => {
    await expect(loginFlow(fakeIO({ prompt: [""] }).io, { store: fakeStore().store })).rejects.toThrow(
      /no provider selected/,
    );
  });

  it("an empty API key fails visibly and writes nothing", async () => {
    const { store, calls } = fakeStore();
    await expect(loginFlow(fakeIO({ hidden: [""] }).io, { provider: "openai", store })).rejects.toThrow(/no API key/);
    expect(calls.set).toBeUndefined();
  });

  // The persistence-failure paths are tested against the REAL AuthStorage (not a mock of the binding the
  // fix depends on): pi RECORDS failures into drainErrors() rather than throwing, and the flow must drain.
  it("real AuthStorage: a corrupt auth file fails up front (preflight), before any prompt or OAuth round-trip", async () => {
    const backend = new InMemoryAuthStorageBackend();
    backend.withLock(() => ({ result: undefined, next: "{ not valid json" })); // corrupt content at construction
    const store = AuthStorage.fromStorage(backend);
    await expect(loginFlow(fakeIO({ hidden: ["sk"] }).io, { provider: "openai", store })).rejects.toThrow(
      /auth file unusable/,
    );
  });

  it("real AuthStorage: a write failure recorded by persistProviderChange surfaces as a thrown error", async () => {
    // Reads clean at construction, throws on write — exercises the REAL persistProviderChange
    // catch → recordError → drainErrors binding (the one new risk point, not a fake of it).
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        const { result, next } = fn(undefined);
        if (next !== undefined) throw new Error("EROFS: read-only file system");
        return result;
      },
      withLockAsync: async (fn) => {
        const { result, next } = await fn(undefined);
        if (next !== undefined) throw new Error("EROFS: read-only file system");
        return result;
      },
    };
    const store = AuthStorage.fromStorage(backend);
    await expect(loginFlow(fakeIO({ hidden: ["sk-x"] }).io, { provider: "openai", store })).rejects.toThrow(
      /failed to save credentials.*EROFS/,
    );
  });

  it("c1: a server win that leaves the manual-paste prompt pending is aborted, so the CLI does not hang", async () => {
    let manualAborted = false;
    const io: LoginIO = {
      print: () => {},
      // The manual-paste prompt never receives an answer (the browser won); it must be aborted, not hang.
      prompt: (_message, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            manualAborted = true;
            reject(new Error("aborted"));
          });
        }),
      promptHidden: async () => "",
      openUrl: () => {},
    };
    const store: AuthStore = {
      getOAuthProviders: () => [{ id: "anthropic", name: "Anthropic" }],
      // pi starts the concurrent manual prompt, then the local server wins: resolve without awaiting it
      // (and .catch it, as pi does, so the later abort-rejection stays handled).
      login: async (_id, callbacks) => {
        void callbacks.onManualCodeInput?.().catch(() => {});
      },
      set: () => {},
      drainErrors: () => [],
    };
    await expect(loginFlow(io, { provider: "anthropic", store })).resolves.toEqual({
      provider: "anthropic",
      method: "oauth",
    });
    expect(manualAborted).toBe(true);
  });
});
