/**
 * A caller's own credential store (#652): an app keeps model credentials in its keychain (`openAgent`'s
 * `credentials`), so every rung that takes `authPath` also takes `credentialStore`, and then reads and writes ONLY that
 * store. The failure this guards is
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
import { MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_AUTH_PATH } from "../src/harnesses/models/credentials.ts";
import { createPiModels, modelEnvironment } from "../src/harnesses/models/environment.ts";
import { login, loginOptions } from "../src/harnesses/models/login.ts";
import { modelsOver, probeAuthSource } from "../src/harnesses/models/models.ts";
import { openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
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

/** An agent that runs anthropic, with no credentials file anywhere. */
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
  it("the opened agent authenticates from the store, and no file is read or written", async () => {
    noAnthropicEnv();
    const { agent } = await agentWorkspace();
    const store = await recordingStore({ anthropic: { type: "api_key", key: "sk-from-store" } });

    const opened = await openServing(agent, { credentialStore: store, storage: "memory" });
    try {
      expect(opened.models.auth).toBeUndefined(); // no file is in use, so none is reported
      expect((await opened.models.authStatus("anthropic")).source).toBe("stored credential");
      expect((await modelEnvironment(agent).authStatus("anthropic")).source).toBeUndefined(); // the files hold nothing
      noCredentialFiles(agent);
    } finally {
      await opened.agent.close();
    }
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

  it("a message authenticates from the store", async () => {
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
    const agent = await openDurableAgent({
      storage: new MemoryStorage(),
      models: modelsOver(store, [gated]),
      registry: createRegistry(),
      name: "faux",
      model: { provider: "faux", modelId: "faux-1" },
    });
    try {
      const sessionId = (await agent.sessions.create()).id;
      expect(await agent.messages.send({ sessionId, content: "hi" }, { wait: 30 })).toMatchObject({
        answer: { text: "ok" },
      });
      expect(store.calls).toContain("read faux");
    } finally {
      await agent.close();
    }
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
    const { host, agent } = await agentWorkspace();
    const both = { authPath: join(host, "auth.json"), credentialStore: await recordingStore() };
    await expect(openServing(agent, { ...both, storage: "memory" })).rejects.toThrow(/not both/);
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
