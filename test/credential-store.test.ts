/**
 * A caller's own credential store (#652): a desktop client keeps model credentials in its keychain, so every rung that
 * takes `authPath` also takes `credentialStore`, and then reads and writes ONLY that store. The failure this guards is
 * silent: a path that still builds `fastagentCredentialStore` would put a credential back into a plain JSON file, or
 * read a login the caller never gave.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthInteraction,
  type Credential,
  type CredentialStore,
  InMemoryCredentialStore,
  type Provider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect } from "../src/collect.ts";
import { GLOBAL_AUTH_PATH } from "../src/engines/pi/auth.ts";
import { createPiAgent } from "../src/engines/pi/create.ts";
import { createAgentService } from "../src/engines/pi/service.ts";
import { login, loginOptions } from "../src/engines/pi/login.ts";
import { createPiModels, probeAuthSource } from "../src/engines/pi/models.ts";
import { availableModelsFromDir, createPiAgentFromDir } from "../src/engines/pi/open.ts";
import { makeFaux } from "./faux.ts";

/** pi's in-memory store, with every call recorded. */
async function recordingStore(
  initial: Record<string, Credential> = {},
): Promise<CredentialStore & { calls: string[] }> {
  const inner = new InMemoryCredentialStore();
  for (const [id, credential] of Object.entries(initial)) await inner.modify(id, async () => credential);
  const calls: string[] = [];
  return {
    calls,
    read: (id, options) => {
      calls.push(`read ${id}`);
      return inner.read(id, options);
    },
    list: (options) => {
      calls.push("list");
      return inner.list(options);
    },
    modify: (id, fn, options) => {
      calls.push(`modify ${id}`);
      return inner.modify(id, fn, options);
    },
    delete: (id, options) => {
      calls.push(`delete ${id}`);
      return inner.delete(id, options);
    },
  };
}

/** A workspace whose agent runs anthropic, with no credentials file anywhere. */
async function agentWorkspace(): Promise<{ host: string; agent: string }> {
  const host = await mkdtemp(join(tmpdir(), "fa-credstore-"));
  const agent = join(host, "fastagent");
  await mkdir(agent);
  await writeFile(join(agent, "fastagent.config.ts"), `export default { model: "anthropic/claude-sonnet-4-5" };\n`);
  return { host, agent };
}

/** Only a store can authenticate anthropic here, whatever this machine's environment holds. */
function noAnthropicEnv(): void {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    vi.stubEnv(name, undefined);
}

const noCredentialFiles = (agent: string) => {
  expect(existsSync(GLOBAL_AUTH_PATH), "the global credentials file").toBe(false);
  expect(existsSync(join(agent, ".secrets", "auth.json")), "the project credentials file").toBe(false);
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a caller's credential store replaces the credentials file", () => {
  it("the directory opener and the model list run on the store, and no file is read or written", async () => {
    noAnthropicEnv();
    const { host, agent } = await agentWorkspace();
    const store = await recordingStore({ anthropic: { type: "api_key", key: "sk-from-store" } });

    const opened = await createPiAgentFromDir(host, { credentialStore: store });
    expect(opened.auth).toBeUndefined(); // no file is in use, so none is reported
    expect(store.calls).toContain("list"); // the runtime was built over the store

    const anthropic = (specs: string[]) => specs.some((spec) => spec.startsWith("anthropic/"));
    expect(anthropic(await availableModelsFromDir(host, { credentialStore: store }))).toBe(true);
    expect(anthropic(await availableModelsFromDir(host))).toBe(false); // the files hold nothing
    noCredentialFiles(agent);
  });

  it("the store replaces the files, not the environment: an env key still authenticates, below a stored one", async () => {
    // Emptying the store does not sign a provider out while its env variable is set (docs/api-reference.md).
    noAnthropicEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-from-env");
    const empty = createPiModels({ credentialStore: await recordingStore() });
    expect(await probeAuthSource(empty, "anthropic/claude-sonnet-4-5")).toBe("ANTHROPIC_API_KEY");
    const stored = createPiModels({
      credentialStore: await recordingStore({ anthropic: { type: "api_key", key: "sk-from-store" } }),
    });
    expect((await stored.getAuth("anthropic"))?.auth.apiKey).toBe("sk-from-store");
  });

  it("createAgentService hands the store to the opener", async () => {
    noAnthropicEnv();
    const { host, agent } = await agentWorkspace();
    const store = await recordingStore({ anthropic: { type: "api_key", key: "sk-from-store" } });
    const service = await createAgentService(host, { credentialStore: store });
    try {
      expect(store.calls).toContain("list");
      noCredentialFiles(agent);
    } finally {
      await service.close();
    }
  });

  it("a turn authenticates from the store (L1)", async () => {
    const { faux } = makeFaux();
    faux.setResponses([fauxAssistantMessage("ok")]);
    // Authenticated ONLY by a stored key, so a turn that completes read it from the store.
    const gated: Provider = {
      ...faux.provider,
      auth: {
        apiKey: {
          name: "faux key",
          resolve: async ({ credential }) =>
            credential?.key === "sk-from-store"
              ? { auth: { apiKey: credential.key }, source: "stored credential" }
              : undefined,
        },
      },
    };
    const store = await recordingStore({ faux: { type: "api_key", key: "sk-from-store" } });
    const agent = createPiAgent({ model: "faux/faux-1", providers: [gated], credentialStore: store });
    expect((await collect(agent.invoke({ session: "s" }, { text: "hi" }))).text).toBe("ok");
    expect(store.calls).toContain("read faux");
  });

  it("an OAuth refresh is written back to the store", async () => {
    const refreshed = { type: "oauth", access: "new-access", refresh: "r2", expires: Date.now() + 3_600_000 } as const;
    const provider = {
      id: "refreshing",
      name: "refreshing",
      getModels: () => [],
      auth: {
        oauth: {
          name: "Refreshing (OAuth)",
          login: async () => refreshed,
          refresh: async () => refreshed,
          toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }),
        },
      },
    } as unknown as Provider;
    const store = await recordingStore({ refreshing: { type: "oauth", access: "old", refresh: "r1", expires: 1 } });
    const models = createPiModels({ credentialStore: store, providers: [provider] });

    expect((await models.getAuth("refreshing"))?.auth.apiKey).toBe("new-access");
    expect(store.calls).toContain("modify refreshing");
    expect(await store.read("refreshing")).toMatchObject({ access: "new-access", refresh: "r2" });
    expect(existsSync(GLOBAL_AUTH_PATH)).toBe(false);
  });

  it("login and its options use the store", async () => {
    const store = await recordingStore();
    const interaction: AuthInteraction = {
      signal: new AbortController().signal,
      notify: () => {},
      prompt: async (prompt) => (prompt.type === "secret" ? "sk-typed" : ""),
    };
    // An API key is verified with one request before it is written; that request is not what this test is about.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await login({ provider: "openai", method: "api_key", credentialStore: store, interaction });
    expect(await store.read("openai")).toMatchObject({ type: "api_key", key: "sk-typed" });
    expect((await loginOptions(store)).find((o) => o.provider === "openai")?.stored).toBe("api_key");
    expect(existsSync(GLOBAL_AUTH_PATH)).toBe(false);
  });

  it("refuses both sources, and a login with neither", async () => {
    const { host } = await agentWorkspace();
    const both = { authPath: join(host, "auth.json"), credentialStore: await recordingStore() };
    await expect(createPiAgentFromDir(host, both)).rejects.toThrow(/not both/);
    await expect(availableModelsFromDir(host, both)).rejects.toThrow(/not both/);
    expect(() => createPiModels(both)).toThrow(/not both/);
    const interaction = { signal: new AbortController().signal, notify: () => {}, prompt: async () => "" };
    // A JavaScript caller can pass either shape the types forbid.
    await expect(login({ provider: "openai", method: "api_key", interaction, ...both } as never)).rejects.toThrow(
      /not both/,
    );
    await expect(login({ provider: "openai", method: "api_key", interaction } as never)).rejects.toThrow(
      /needs authPath or credentialStore/,
    );
  });
});
