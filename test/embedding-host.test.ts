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
import { GLOBAL_AUTH_PATH } from "../src/harnesses/models/credentials.ts";
import { modelsOver } from "../src/harnesses/models/models.ts";
import {
  type Credential,
  type CredentialStore,
  type SignInInteraction,
  addContent,
  createAgent,
  credentialFile,
  listContent,
  removeContent,
  signIn,
  signInOptions,
} from "../src/index.ts";
import { openSource } from "./open-source.ts";
import { keepCatalog } from "./kept-catalog.ts";

vi.mock("../src/git.ts", () => import("./git-double.ts"));

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
});

describe("an agent's own content, from the package entry", () => {
  const folders = async () => {
    const base = await tmp("fa-host-content-");
    const made = ["notes", "app", "handbook"].map((name) => join(base, name));
    for (const dir of made) await mkdir(dir);
    return { base, notes: made[0] as string, app: made[1] as string, handbook: made[2] as string };
  };
  const bind = (name: string, path: string) => ({ name, entry: { path } });

  it("is created with any number of folders, edited and listed", async () => {
    const { base, notes, app, handbook } = await folders();
    const dir = join(base, "agent");
    const created = await createAgent(dir, { content: [bind("app", app), bind("handbook", handbook)] });
    expect(created.content.map(({ name }) => name)).toEqual(["app", "handbook"]);

    const edit = await addContent(dir, bind("notes", notes));
    expect(edit.content.map(({ name }) => name).sort()).toEqual(["app", "handbook", "notes"]);
    expect((await listContent(dir)).content).toHaveLength(3);

    const removed = await removeContent(dir, "NOTES");
    expect(removed.name).toBe("notes");
    expect((await listContent(dir)).content.map(({ name }) => name).sort()).toEqual(["app", "handbook"]);
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
    const stateDir = join(homedir(), "host-state", "agent");
    const store = hostStore({ anthropic: { type: "api_key", key: "sk-host" } });
    // The model lists are the instance's too: a model only the host's kept list has is offered.
    const anthropic = modelsOver(new InMemoryCredentialStore()).getModels("anthropic")[0] as AnyModel;
    keepCatalog(join(stateDir, "models"), [{ ...anthropic, id: "claude-released" }]);

    await expect(openSource(dir, { stateDir: "host-state" })).rejects.toThrow(
      'stateDir must be an absolute path, and is "host-state"',
    );
    const hosted = await openSource(dir, { credentials: store, stateDir });
    // The directory's own instance (what `fastagent dev` opens) is not held by the host's.
    const own = await openSource(dir);
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
