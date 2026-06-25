import { describe, expect, it } from "vitest";
import type { AuthStore, LoginIO } from "../src/engines/pi/login.ts";
import { loginFlow } from "../src/engines/pi/login.ts";

/** A fake AuthStore recording the calls the flow makes (anthropic/openai-codex are OAuth-capable). */
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
});
