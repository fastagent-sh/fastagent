import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProviderInfoList } from "@earendil-works/pi-ai/oauth";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { fastagentCredentialStore } from "../src/engines/pi/auth.ts";
import type { LoginIO, OAuthFlow } from "../src/engines/pi/login.ts";
import { loginFlow } from "../src/engines/pi/login.ts";

// The store is the REAL fastagentCredentialStore over a temp file — the same writer the runtime uses,
// so these tests exercise the actual persist/corruption semantics, not a mock of them. Only the OAuth
// device/browser flow (external) is injected.
async function tmpAuth(content?: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fa-login-")), "auth.json");
  if (content !== undefined) await writeFile(path, content);
  return path;
}
const readAuth = async (path: string) => JSON.parse(await readFile(path, "utf8"));

/** A fake terminal: scripted prompt/hidden answers, no real stdin/browser. */
function fakeIO(answers: { prompt?: string[]; hidden?: string[] } = {}): LoginIO {
  const prompts = [...(answers.prompt ?? [])];
  const hiddens = [...(answers.hidden ?? [])];
  return {
    print: () => {},
    prompt: async () => prompts.shift() ?? "",
    promptHidden: async () => hiddens.shift() ?? "",
    openUrl: () => {},
  };
}

const fakeCreds = { access: "tok", refresh: "rt", expires: Date.now() + 3_600_000 } as unknown as OAuthCredentials;
const oauthOk: OAuthFlow = async () => fakeCreds;

describe("loginFlow", () => {
  it("an OAuth-capable provider runs the flow and persists {type:oauth} via the store", async () => {
    const path = await tmpAuth();
    const store = fastagentCredentialStore(path);
    const res = await loginFlow(fakeIO(), { provider: "anthropic", store, oauthFlow: oauthOk });
    expect(res).toEqual({ provider: "anthropic", method: "oauth" });
    expect((await readAuth(path)).anthropic).toMatchObject({ type: "oauth", access: "tok" });
  });

  it("any non-OAuth provider prompts (hidden) for and persists {type:api_key}", async () => {
    const path = await tmpAuth();
    const store = fastagentCredentialStore(path);
    const res = await loginFlow(fakeIO({ hidden: ["sk-123"] }), { provider: "openai", store, oauthFlow: oauthOk });
    expect(res).toEqual({ provider: "openai", method: "api_key" });
    expect((await readAuth(path)).openai).toEqual({ type: "api_key", key: "sk-123" });
  });

  it("no provider → interactive select among the real OAuth providers (by number or id)", async () => {
    const first = getOAuthProviderInfoList()[0]?.id; // the list is pi's; assert against it, not a hardcode
    const byNumber = await loginFlow(fakeIO({ prompt: ["1"] }), {
      store: fastagentCredentialStore(await tmpAuth()),
      oauthFlow: oauthOk,
    });
    expect(byNumber.provider).toBe(first);
    const byId = await loginFlow(fakeIO({ prompt: ["anthropic"] }), {
      store: fastagentCredentialStore(await tmpAuth()),
      oauthFlow: oauthOk,
    });
    expect(byId.provider).toBe("anthropic");
  });

  it("an empty selection fails visibly", async () => {
    await expect(
      loginFlow(fakeIO({ prompt: [""] }), { store: fastagentCredentialStore(await tmpAuth()), oauthFlow: oauthOk }),
    ).rejects.toThrow(/no provider selected/);
  });

  it("an empty API key fails visibly and persists no credential", async () => {
    const path = await tmpAuth();
    await expect(
      loginFlow(fakeIO({ hidden: [""] }), {
        provider: "openai",
        store: fastagentCredentialStore(path),
        oauthFlow: oauthOk,
      }),
    ).rejects.toThrow(/no API key/);
    // The preflight modify may touch the file ("{}"), but no openai credential was written.
    expect((await readAuth(path).catch(() => ({}))).openai).toBeUndefined();
  });

  it("a corrupt auth file fails up front (preflight), before the OAuth round-trip", async () => {
    const path = await tmpAuth("{ not valid json");
    let flowRan = false;
    const oauthFlow: OAuthFlow = async () => {
      flowRan = true;
      return fakeCreds;
    };
    await expect(
      loginFlow(fakeIO(), { provider: "anthropic", store: fastagentCredentialStore(path), oauthFlow }),
    ).rejects.toThrow(/corrupt auth file/);
    expect(flowRan).toBe(false); // preflight threw before the flow — no wasted round-trip
  });

  it("c1: a server win that leaves the manual-paste prompt pending is aborted, so the CLI does not hang", async () => {
    let manualAborted = false;
    const io: LoginIO = {
      print: () => {},
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
    // The flow starts the concurrent manual prompt, then the server wins: resolve without awaiting it.
    const oauthFlow: OAuthFlow = async (_id, callbacks) => {
      void callbacks.onManualCodeInput?.().catch(() => {});
      return fakeCreds;
    };
    await expect(
      loginFlow(io, { provider: "anthropic", store: fastagentCredentialStore(await tmpAuth()), oauthFlow }),
    ).resolves.toEqual({ provider: "anthropic", method: "oauth" });
    expect(manualAborted).toBe(true);
  });
});
