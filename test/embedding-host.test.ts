/**
 * What a host embedding agents calls beyond the Agent API, through the package entry: a credential store of its own
 * (FastAgent's types, no pi-ai), FastAgent's credentials file, sign-in, what authenticates a provider, and an instance
 * of its own beside `fastagent dev`'s. The sign-in and credential rules are tested where they live (login.test.ts,
 * credential-store.test.ts); this file owns the translation and the wiring.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyModel, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as login from "../src/harnesses/models/login.ts";
import { GLOBAL_AUTH_PATH } from "../src/harnesses/models/credentials.ts";
import { modelsOver } from "../src/harnesses/models/models.ts";
import {
  ContentNameError,
  type Credential,
  type CredentialStore,
  type SignInInteraction,
  SignInCancelled,
  addContent,
  createAgent,
  credentialFile,
  listContent,
  openAgent,
  providerAuth,
  readContentSource,
  removeContent,
  signIn,
  signInOptions,
} from "../src/index.ts";
import { MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import { makeFaux } from "./faux.ts";
import { keepCatalog } from "./kept-catalog.ts";

/** A host's own store, in FastAgent's types: a map, with `modify` run one at a time. */
function hostStore(initial: Record<string, Credential> = {}): CredentialStore & { calls: string[] } {
  const held = new Map(Object.entries(initial));
  const calls: string[] = [];
  let line: Promise<unknown> = Promise.resolve();
  return {
    calls,
    read: async (provider) => {
      calls.push(`read ${provider}`);
      return held.get(provider);
    },
    list: async () => [...held].map(([provider, { type }]) => ({ provider, type })),
    modify: (provider, change) => {
      calls.push(`modify ${provider}`);
      const run = line.then(async () => {
        const next = await change(held.get(provider));
        if (next !== undefined) held.set(provider, next);
        return held.get(provider);
      });
      line = run.catch(() => undefined);
      return run;
    },
    delete: async (provider) => {
      held.delete(provider);
    },
  };
}

/** Answers a key prompt with `key`; any other question fails the test. */
function typing(key: string, signal?: AbortSignal): SignInInteraction & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    ...(signal ? { signal } : {}),
    notify: () => {},
    prompt: async (prompt) => {
      prompts.push(prompt.type);
      if (prompt.type !== "secret") throw new Error(`unexpected ${prompt.type} prompt`);
      return key;
    },
  };
}

const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a host's credentials", () => {
  it("a sign-in over a host's store writes only there, and its options say what authenticates each provider", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    const store = hostStore({ anthropic: { type: "api_key", key: "sk-stored" } });
    // An API key is checked with one request before it is stored; that request is not what this test is about.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const interaction = typing("sk-typed");
    expect(await signIn({ credentials: store, provider: "openai", method: "api_key", interaction })).toEqual({
      provider: "openai",
      method: "api_key",
      verified: "unknown",
    });
    expect(interaction.prompts).toEqual(["secret"]);
    expect(await store.read("openai")).toEqual({ type: "api_key", key: "sk-typed" });

    const options = await signInOptions(store);
    expect(options.find((o) => o.provider === "openai" && o.method === "api_key")).toMatchObject({
      status: { type: "api_key", source: "stored credential" },
    });
    // The environment's key still answers once the stored one is signed out.
    expect(options.find((o) => o.provider === "anthropic" && o.method === "api_key")).toMatchObject({
      status: { source: "stored credential" },
      environment: "ANTHROPIC_API_KEY",
    });
    expect(existsSync(GLOBAL_AUTH_PATH)).toBe(false);
  });

  it("an aborted sign-in, or one the person backs out of, rejects with SignInCancelled and stores nothing", async () => {
    const store = hostStore();
    const abort = new AbortController();
    abort.abort();
    const signingIn = signIn({
      credentials: store,
      provider: "openai",
      method: "api_key",
      interaction: typing("sk-typed", abort.signal),
    });
    await expect(signingIn).rejects.toBeInstanceOf(SignInCancelled);
    // The person backing out of a question, as the host's UI says so.
    const backingOut: SignInInteraction = {
      notify: () => {},
      prompt: async () => {
        throw new SignInCancelled("closed the dialog");
      },
    };
    await expect(
      signIn({ credentials: store, provider: "openai", method: "api_key", interaction: backingOut }),
    ).rejects.toBeInstanceOf(SignInCancelled);
    expect(await store.list()).toEqual([]);
  });

  it("credentialFile is FastAgent's file: written whole, listed by provider, and a corrupt one refuses", async () => {
    const path = join(await tmp("fa-host-creds-"), "auth.json");
    const file = credentialFile(path);
    await file.modify("openai", async () => ({ type: "api_key", key: "sk-1" }));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ openai: { type: "api_key", key: "sk-1" } });
    expect(await file.list()).toEqual([{ provider: "openai", type: "api_key" }]);
    await file.delete("openai");
    expect(await file.read("openai")).toBeUndefined();

    // Read as empty, the next write would replace every provider's credential.
    await writeFile(path, "{bad");
    await expect(file.read("openai")).rejects.toThrow(/corrupt auth file/);
    await expect(file.list()).rejects.toThrow(/corrupt auth file/);
    const interaction = typing("sk-2");
    await expect(signIn({ credentials: file, provider: "openai", method: "api_key", interaction })).rejects.toThrow(
      /corrupt auth file/,
    );
    expect(interaction.prompts).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("{bad");
  });

  it("a sign-in keeps the installation's id beside credentialFile's file, and takes a host store's own", async () => {
    const run = vi
      .spyOn(login, "loginOver")
      .mockResolvedValue({ provider: "openai", method: "oauth", verified: "n/a" });
    const interaction = typing("unused");

    // Resolved as the store resolves it: `~/…` is the home directory's, so the id is kept beside the credentials.
    await signIn({ credentials: credentialFile("~/host/auth.json"), provider: "openai", method: "oauth", interaction });
    expect(run.mock.calls[0]?.[0]).toMatchObject({ authPath: join(homedir(), "host", "auth.json") });
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("credentialStore");
    expect(() => credentialFile("")).toThrow("credentialFile needs the path of a credentials file");

    await signIn({ credentials: hostStore(), provider: "openai", method: "oauth", interaction, deviceId: "dev-1" });
    const request = run.mock.calls[1]?.[0];
    expect(request).not.toHaveProperty("authPath");
    expect(request?.getDeviceId?.()).toBe("dev-1");
  });

  it("providerAuth answers what a request sends: the stored key, else the environment's, else nothing", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(await providerAuth(hostStore(), "openai")).toBeUndefined();
    expect(await providerAuth(hostStore({ openai: { type: "api_key", key: "sk-stored" } }), "openai")).toMatchObject({
      type: "api_key",
      apiKey: "sk-stored",
    });
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    expect(await providerAuth(hostStore(), "openai")).toEqual({
      type: "api_key",
      source: "OPENAI_API_KEY",
      apiKey: "sk-env",
    });
    await expect(providerAuth(hostStore(), "nope")).rejects.toThrow('unknown provider "nope"');
    // A provider that authenticates by a header, and one whose credential decides where requests go.
    const signedIn = { type: "oauth", access: "at-1", refresh: "rt-1", expires: Date.now() + 3_600_000 } as const;
    expect(await providerAuth(hostStore({ "kimi-coding": signedIn }), "kimi-coding")).toMatchObject({
      type: "oauth",
      headers: { Authorization: "Bearer at-1" },
    });
    expect(await providerAuth(hostStore({ "github-copilot": signedIn }), "github-copilot")).toMatchObject({
      apiKey: "at-1",
      baseUrl: expect.stringMatching(/^https:\/\/.*githubcopilot\.com/),
    });
  });
});

describe("the models an agent offers", () => {
  it("say each model's context window, and none for a model that declares none (pi reads it as 0)", async () => {
    const { models } = makeFaux({
      models: [
        { id: "sized", contextWindow: 1000 },
        { id: "unsized", contextWindow: 0 },
      ],
    });
    const agent = await openDurableAgent({
      storage: new MemoryStorage(),
      models,
      registry: createRegistry(),
      name: "w",
    });
    try {
      const offered = (await agent.info()).models;
      expect(offered.find((model) => model.modelId === "sized")).toMatchObject({ contextWindow: 1000 });
      expect(offered.find((model) => model.modelId === "unsized")).not.toHaveProperty("contextWindow");
    } finally {
      await agent.close();
    }
  });
});

describe("an agent's own content, from the package entry", () => {
  const folders = async () => {
    const base = await tmp("fa-host-content-");
    const made = ["notes", "app", "handbook"].map((name) => join(base, name));
    for (const dir of made) await mkdir(dir);
    return { base, notes: made[0] as string, app: made[1] as string, handbook: made[2] as string };
  };
  const bind = (name: string, path: string, readonly = false) => ({ name, binding: { path, readonly } });

  it("is created with any number of folders, edited and listed", async () => {
    const { base, notes, app, handbook } = await folders();
    const dir = join(base, "agent");
    const created = await createAgent(dir, { content: [bind("app", app), bind("handbook", handbook, true)] });
    expect(created.content.map(({ name, readonly }) => ({ name, readonly }))).toEqual([
      { name: "app", readonly: false },
      { name: "handbook", readonly: true },
    ]);

    const edit = await addContent(dir, bind("notes", notes));
    expect(edit.content.map(({ name }) => name).sort()).toEqual(["app", "handbook", "notes"]);
    expect((await listContent(dir)).content).toHaveLength(3);

    const removed = await removeContent(dir, "NOTES");
    expect(removed.name).toBe("notes");
    expect((await listContent(dir)).content.map(({ name }) => name).sort()).toEqual(["app", "handbook"]);
  });

  it("refuses a name the agent has, and a created agent with one bad entry leaves no directory", async () => {
    const { base, notes, app } = await folders();
    const dir = join(base, "agent");
    await createAgent(dir, { content: [bind("app", app)] });
    await expect(addContent(dir, bind("App", notes))).rejects.toBeInstanceOf(ContentNameError);

    const refused = join(base, "refused");
    await expect(createAgent(refused, { content: [bind("app", app), bind("bad name", notes)] })).rejects.toBeInstanceOf(
      ContentNameError,
    );
    expect(existsSync(refused)).toBe(false);
  });

  it("reads a folder as the CLI does: named for it, bound on this machine", async () => {
    const { notes } = await folders();
    const { addition } = readContentSource(notes, process.cwd(), { readonly: true });
    expect(addition).toEqual({ name: "notes", binding: { path: notes, readonly: true } });
  });

  it("accepts two names for one folder, and a folder inside another", async () => {
    const { base, app } = await folders();
    const inner = join(app, "src");
    await mkdir(inner);
    const created = await createAgent(join(base, "agent"), {
      content: [bind("a", app), bind("b", app), bind("inner", inner)],
    });
    expect(created.content.map(({ name }) => name).sort()).toEqual(["a", "b", "inner"]);
  });
});

describe("the thinking levels a model offers", () => {
  it("are those the model supports: only off for a model that does not reason", async () => {
    const { models } = makeFaux({
      models: [
        { id: "plain", reasoning: false },
        { id: "reasoner", reasoning: true },
      ],
    });
    const agent = await openDurableAgent({
      storage: new MemoryStorage(),
      models,
      registry: createRegistry(),
      name: "t",
    });
    try {
      const offered = (await agent.info()).models;
      expect(offered.find((model) => model.modelId === "plain")?.thinkingLevels).toEqual(["off"]);
      const levels = offered.find((model) => model.modelId === "reasoner")?.thinkingLevels;
      expect(levels?.[0]).toBe("off");
      expect(levels).toContain("high");
    } finally {
      await agent.close();
    }
  });
});

describe("a host's own instance of an agent", () => {
  it("opens beside the directory's own instance, on the host's store, offering each model's context window", async () => {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
      vi.stubEnv(name, undefined);
    const base = await tmp("fa-host-instance-");
    const dir = join(base, "agent");
    await mkdir(dir);
    await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
    // Read as FASTAGENT_STATE_DIR is: `~/…` is the home directory's.
    const stateDir = join(homedir(), "host-state", "agent");
    const store = hostStore({ anthropic: { type: "api_key", key: "sk-host" } });
    // The model lists are the instance's too: a model only the host's kept list has is offered.
    const anthropic = modelsOver(new InMemoryCredentialStore()).getModels("anthropic")[0] as AnyModel;
    keepCatalog(join(stateDir, "models"), [{ ...anthropic, id: "claude-released" }]);

    await expect(openAgent(dir, { stateDir: "" })).rejects.toThrow(
      "stateDir needs the directory the instance's state is kept in",
    );
    const hosted = await openAgent(dir, { credentials: store, stateDir: "~/host-state/agent" });
    // The directory's own instance (what `fastagent dev` opens) is not held by the host's.
    const own = await openAgent(dir);
    try {
      expect(existsSync(join(stateDir, "agent.sqlite"))).toBe(true);
      const offered = (await hosted.info()).models;
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.every((model) => model.provider === "anthropic")).toBe(true);
      expect(offered.every((model) => (model.contextWindow ?? 0) > 0)).toBe(true);
      expect(offered.map((model) => model.modelId)).toContain("claude-released");
      expect(store.calls).toContain("read anthropic");
      expect((await own.info()).models).toEqual([]);
    } finally {
      await own.close();
      await hosted.close();
    }
    expect(existsSync(join(dir, ".state", "agent.sqlite"))).toBe(true);
  });
});
