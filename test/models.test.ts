import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  type Api,
  InMemoryCredentialStore,
  type Model,
  type Models,
  createProvider,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createPiModelRuntime,
  literalKeyProviders,
  globalCatalogPath,
  machineModels,
  definitionKeyOf,
  probeApiKey,
  probeAuthSource,
  providerAuthStatuses,
  refreshCatalog,
  modelRuntimeFiles,
} from "../src/engines/pi/models.ts";
import { fastagentCredentialStore } from "../src/engines/pi/auth.ts";
import { agentModels, createPiModels } from "../src/engines/pi/agent-models.ts";
import { resolveModel } from "../src/engines/pi/config.ts";
import { createPiAgentFromDir } from "../src/engines/pi/open.ts";

type FakeProvider = {
  id: string;
  models: string[];
  auth: "ok" | "none" | "reject";
  oauth?: boolean;
  apiKeyLogin?: boolean;
};

/** A minimal Models stub exposing only what providerAuthStatuses touches: getProviders + getAuth. */
function fakeModels(providers: FakeProvider[]): Models {
  return {
    getProviders: () =>
      providers.map((p) => ({
        id: p.id,
        // interactiveLoginKind probes both surfaces: OAuth, and an interactive api-key entry flow.
        auth: { oauth: p.oauth ? {} : undefined, apiKey: p.apiKeyLogin ? { login: () => {} } : undefined },
        getModels: () => p.models.map((id) => ({ id, provider: p.id })),
      })),
    getAuth: async (model: { provider: string }) => {
      const p = providers.find((x) => x.id === model.provider);
      if (!p || p.auth === "reject") throw new Error("expired");
      return p.auth === "ok" ? { source: "TEST_KEY" } : undefined;
    },
  } as unknown as Models;
}

describe("providerAuthStatuses", () => {
  it("maps usable → ready (with source), unconfigured, and rejecting → broken (with the message)", async () => {
    const statuses = await providerAuthStatuses(
      fakeModels([
        { id: "anthropic", models: ["claude-a"], auth: "ok" },
        { id: "openai", models: ["gpt-x"], auth: "none", oauth: true },
        { id: "envonly", models: ["m1"], auth: "none" }, // no interactive login → the picker says "set the env var"
        { id: "keylogin", models: ["m2"], auth: "none", apiKeyLogin: true }, // key ENTRY flow → "api_key"
        { id: "both", models: ["m3"], auth: "none", oauth: true, apiKeyLogin: true }, // OAuth wins when both exist
        { id: "codex", models: ["gpt-5.5"], auth: "reject", oauth: true }, // configured-but-broken → data, not a silent drop
        { id: "empty", models: [], auth: "ok" }, // no models → nothing to pick → omitted
      ]),
    );
    expect(statuses.get("anthropic")).toEqual({ state: "ready", source: "TEST_KEY" });
    expect(statuses.get("openai")).toEqual({ state: "unconfigured", login: "oauth" });
    expect(statuses.get("envonly")).toEqual({ state: "unconfigured", login: "none" });
    expect(statuses.get("keylogin")).toEqual({ state: "unconfigured", login: "api_key" });
    expect(statuses.get("both")).toEqual({ state: "unconfigured", login: "oauth" });
    expect(statuses.get("codex")).toEqual({ state: "broken", message: "expired", login: "oauth" });
    expect(statuses.has("empty")).toBe(false);
  });
});

describe("probeApiKey (the post-login quick-fail check)", () => {
  const model = { id: "m", provider: "p" } as unknown as Model<Api>;
  /** A Models stub exposing only `complete`; `status` drives the onResponse callback. */
  const stub = (reply: { stopReason: string; errorMessage?: string } | "throw", status?: number): Models =>
    ({
      complete: async (_m: unknown, _ctx: unknown, opts?: { onResponse?: (r: { status: number }) => void }) => {
        if (status !== undefined) opts?.onResponse?.({ status });
        if (reply === "throw") throw new Error("store unreadable");
        return reply;
      },
    }) as unknown as Models;

  it("a normal reply → ok (stop or length both count)", async () => {
    expect(await probeApiKey(stub({ stopReason: "length" }, 200), model)).toEqual({ state: "ok" });
  });

  it("HTTP 401 → rejected — the only DEFINITIVE verdict (callers may delete state on it)", async () => {
    expect(await probeApiKey(stub({ stopReason: "error", errorMessage: "invalid x-api-key" }, 401), model)).toEqual({
      state: "rejected",
      message: "invalid x-api-key",
    });
  });

  it("no captured status falls back to a conservative 401 match in the error text", async () => {
    expect(await probeApiKey(stub({ stopReason: "error", errorMessage: "401 Unauthorized" }), model)).toEqual({
      state: "rejected",
      message: "401 Unauthorized",
    });
    // "4011"/"1401" must NOT match — the fallback is a word-ish boundary, not a substring
    expect(await probeApiKey(stub({ stopReason: "error", errorMessage: "code 14011" }), model)).toEqual({
      state: "unknown",
      message: "code 14011",
    });
  });

  it("403 / network-ish failures → unknown (a valid key can 403; transport says nothing) — kept", async () => {
    expect(await probeApiKey(stub({ stopReason: "error", errorMessage: "forbidden" }, 403), model)).toEqual({
      state: "unknown",
      message: "forbidden",
    });
    expect(await probeApiKey(stub("throw"), model)).toEqual({ state: "unknown", message: "store unreadable" });
  });
});

describe("models.json: definition-local custom endpoints (createPiModelRuntime)", () => {
  it("waits for injected providers' registration refreshes before publishing the runtime", async () => {
    const nativeRefresh = ModelRuntime.prototype.refresh;
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const refresh = vi.spyOn(ModelRuntime.prototype, "refresh").mockImplementation(async function (
      this: ModelRuntime,
      options,
    ) {
      if (this.getRegisteredNativeProvider("faux")) {
        entered = true;
        await blocked;
      }
      return nativeRefresh.call(this, options);
    });
    let ready = false;
    const loaded = createPiModelRuntime({
      credentials: new InMemoryCredentialStore(),
      machineLayer: false,
      providers: [fauxProvider().provider],
    }).then((runtime) => {
      ready = true;
      return runtime;
    });
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      await setImmediate();
      expect(ready).toBe(false);
    } finally {
      release();
      await loaded;
      refresh.mockRestore();
    }
    expect((await loaded).hasConfiguredAuth("faux")).toBe(true);
  });
  /** An agent dir with `models.json` — the file that declares a self-hosted / gateway endpoint. */
  async function agentWith(modelsJson: string | undefined): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fastagent-modelsjson-"));
    await writeFile(join(dir, "fastagent.config.ts"), "export default {};");
    if (modelsJson !== undefined) await writeFile(join(dir, "models.json"), modelsJson);
    return dir;
  }

  const GATEWAY = JSON.stringify({
    providers: {
      mygw: {
        baseUrl: "http://vllm.internal:8000/v1",
        api: "openai-completions",
        apiKey: "$FASTAGENT_TEST_GW_KEY",
        models: [{ id: "deepseek-v3", contextWindow: 65536 }],
      },
    },
  });

  it("a declared endpoint becomes a resolvable model, and its key comes from the environment", async () => {
    const dir = await agentWith(GATEWAY);
    const runtime = await createPiModelRuntime({
      agentDir: dir,
      credentials: fastagentCredentialStore(join(dir, "auth.json")),
    });

    // The point of the feature: `<id>/<modelId>` resolves, carrying the AUTHOR's endpoint — not a
    // built-in's. contextWindow is the declared one; maxTokens is pi's documented default (16384),
    // which is what makes "endpoint + key + model name" a complete config.
    const model = resolveModel(runtime, "mygw/deepseek-v3");
    expect(model.baseUrl).toBe("http://vllm.internal:8000/v1");
    expect(model.contextWindow).toBe(65536);
    expect(model.maxTokens).toBe(16384);
    // Built-ins are kept alongside, so a custom endpoint is additive, never a replacement.
    expect(runtime.getProvider("anthropic")).toBeDefined();

    // `apiKey: "$ENV"` must interpolate on the SERVING path too (pi documents it for the TUI): the key
    // stays out of the file, which is what lets models.json be committed and baked into an image.
    process.env.FASTAGENT_TEST_GW_KEY = "sk-from-env";
    try {
      // Assert the SHAPE, not just presence: probeAuthSource flattens every models.json endpoint to this
      // display label, which is why `deploy` cannot branch on it (it reads the file: definitionKeyOf below).
      expect(await probeAuthSource(runtime, "mygw/deepseek-v3")).toBe("configured API key");
    } finally {
      delete process.env.FASTAGENT_TEST_GW_KEY;
    }
  });

  it("definitionKeyOf reads how the FILE supplies a provider's key: a variable to carry, or a key that travels in it", async () => {
    // What deploy asks, answered from the definition alone: the file ships, and nothing on this machine does.
    const keyed = (apiKey: string) =>
      agentWith(JSON.stringify({ providers: { mygw: { baseUrl: "http://x/v1", api: "openai-completions", apiKey } } }));
    for (const apiKey of ["sk-literal-in-file", "!echo sk-from-command"]) {
      expect(await definitionKeyOf(await keyed(apiKey), "mygw")).toEqual({ inFile: true });
    }
    expect(await definitionKeyOf(await keyed("$GW_KEY"), "mygw")).toEqual({ reference: "GW_KEY" });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: pi's own `${NAME}` form, written literally in models.json
    expect(await definitionKeyOf(await keyed("${GW_KEY}"), "mygw")).toEqual({ reference: "GW_KEY" });
    expect(await definitionKeyOf(await keyed("$GW_KEY"), "anthropic")).toBeUndefined(); // not declared there
  });

  it("literalKeyProviders reads the FILE, so a stored credential cannot hide a literal that still ships", async () => {
    // getProviderAuthStatus answers "what satisfies this provider now" and returns `stored` first, so a provider
    // with both an auth.json entry and a literal in the file would report `stored` — and the literal would ship
    // unreported. The gate asks what the definition DECLARES, which only the file answers.
    const dir = await agentWith(
      JSON.stringify({
        providers: {
          literal: { baseUrl: "https://a.example.com/v1", api: "o", apiKey: "sk-in-file", models: [{ id: "m" }] },
          // `$$` is pi's escape for a literal `$`, so this resolves to `sk$abc` — a credential, not a reference.
          escaped: { baseUrl: "https://f.example.com/v1", api: "o", apiKey: "sk$$abc", models: [{ id: "m" }] },
          local: { baseUrl: "http://localhost:11434/v1", api: "o", apiKey: "ollama", models: [{ id: "m" }] },
          lan: { baseUrl: "http://10.0.0.7:8000/v1", api: "o", apiKey: "placeholder", models: [{ id: "m" }] },
          reference: { baseUrl: "https://b.example.com/v1", api: "o", apiKey: "$GW_KEY", models: [{ id: "m" }] },
          braced: { baseUrl: "https://c.example.com/v1", api: "o", apiKey: `\${GW_KEY}`, models: [{ id: "m" }] },
          command: { baseUrl: "https://d.example.com/v1", api: "o", apiKey: "!echo sk", models: [{ id: "m" }] },
          none: { baseUrl: "https://e.example.com/v1", api: "o", models: [{ id: "m" }] },
        },
      }),
    );
    await writeFile(join(dir, "auth.json"), JSON.stringify({ literal: { type: "api_key", key: "sk-stored" } }));
    // Every literal is reported, wherever it points: the caller warns, and whether a given string is a credential
    // is the author's knowledge. `escaped` is the one that would slip through a naive reference check.
    expect(await literalKeyProviders(dir)).toEqual(["literal", "escaped", "local", "lan"]);
    expect(await literalKeyProviders(join(dir, "no-such-dir"))).toEqual([]); // no models.json is the normal case
  });

  it("on an id collision the file wins over an injected Provider (models.json composes over the native base)", async () => {
    // Upstream installs a registerNativeProvider() provider as the BASE and composes the models.json
    // entry over it — the opposite of the built-in case, where an injected provider overrides. Pinned
    // because the docs promise it and because it is the direction that keeps a DEPLOYED agent's traffic
    // decided by its definition rather than by the program that embedded it.
    const dir = await agentWith(GATEWAY); // declares "mygw" at http://vllm.internal:8000/v1
    const injected = createProvider({
      id: "mygw",
      baseUrl: "https://from-injected-code/v1",
      auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" }, source: "code" }) } },
      models: [
        {
          id: "deepseek-v3",
          name: "injected",
          api: "openai-completions",
          provider: "mygw",
          baseUrl: "https://from-injected-code/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 111,
          maxTokens: 222,
        },
      ],
      api: { stream: () => undefined, streamSimple: () => undefined } as never,
    });

    const runtime = await createPiModelRuntime({
      agentDir: dir,
      credentials: fastagentCredentialStore(join(dir, "auth.json")),
      providers: [injected],
    });
    const model = resolveModel(runtime, "mygw/deepseek-v3");
    expect(model.baseUrl).toBe("http://vllm.internal:8000/v1"); // the file, not the injected code
    expect(model.contextWindow).toBe(65536); // the file's value, not the injected 111
  });

  it("a malformed models.json fails visibly instead of degrading to the built-ins", async () => {
    // Upstream `ModelRuntime.create` RESOLVES on a parse error and parks the reason in getError(),
    // so an unread error would surface later as a bare "unknown model" — the silent fallback this
    // codebase forbids. The throw must name the file so the typo is findable.
    const dir = await agentWith("{ not json");
    await expect(
      createPiModelRuntime({ agentDir: dir, credentials: fastagentCredentialStore(join(dir, "auth.json")) }),
    ).rejects.toThrow(/models\.json/);
  });

  it("no models.json is the normal case: built-ins load, nothing throws", async () => {
    const dir = await agentWith(undefined);
    const runtime = await createPiModelRuntime({
      agentDir: dir,
      credentials: fastagentCredentialStore(join(dir, "auth.json")),
    });
    expect(runtime.getProvider("anthropic")).toBeDefined();
  });

  it("reading the model catalogs writes nothing: no models-store.json appears where no refresh wrote one", async () => {
    // pi's own file store creates its file on first read, which would drop an empty catalog into every agent dir.
    const dir = await agentWith(GATEWAY);
    await createPiModelRuntime({ agentDir: dir, credentials: fastagentCredentialStore(join(dir, "auth.json")) });
    expect(existsSync(join(dir, "models-store.json"))).toBe(false);
    expect(existsSync(join(dir, ".state", "models-store.json"))).toBe(false);
    expect(existsSync(globalCatalogPath())).toBe(false);
  });

  it("the model files are live: the catalog and every session runtime read an edit, through one read", async () => {
    // One read for both planes: the control plane lists and validates against what a session then runs on.
    const dir = await agentWith(GATEWAY);
    const models = agentModels(dir, { authPath: join(dir, "auth.json") });
    const startup = await models.runtime();
    expect(resolveModel(startup, "mygw/deepseek-v3").baseUrl).toBe("http://vllm.internal:8000/v1");
    expect(await models.runtime()).toBe(startup); // unchanged files: the same catalog

    await writeFile(join(dir, "models.json"), GATEWAY.replace("vllm.internal", "edited.internal"));
    await writeFile(
      join(dir, "models-store.json"),
      JSON.stringify({
        anthropic: {
          lastModified: Date.now() + 86_400_000,
          models: [{ ...startup.getProvider("anthropic")!.getModels()[0], id: "catalog-added" }],
        },
      }),
    );
    for (const runtime of [await models.runtime(), await models.createRuntime()]) {
      expect(resolveModel(runtime, "mygw/deepseek-v3").baseUrl).toBe("http://edited.internal:8000/v1");
      expect(runtime.getModel("anthropic", "catalog-added")).toBeDefined();
    }
  });

  it("an edit that does not load keeps the files read before, said once; a start on it fails, naming the file", async () => {
    // The agent can write its own models.json: if a broken one failed every turn, no turn would be left to fix it.
    const dir = await agentWith(GATEWAY);
    const models = agentModels(dir, { authPath: join(dir, "auth.json") });
    await models.runtime();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(join(dir, "models.json"), "{ not json");
      for (const runtime of [await models.runtime(), await models.createRuntime(), await models.runtime()]) {
        expect(resolveModel(runtime, "mygw/deepseek-v3").baseUrl).toBe("http://vllm.internal:8000/v1");
      }
      const said = errors.mock.calls.map((call) => call.join(" ")).filter((line) => /cannot be used/.test(line));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(join(dir, "models.json"));
      // Fixed: read again.
      await writeFile(join(dir, "models.json"), GATEWAY.replace("vllm.internal", "fixed.internal"));
      expect(resolveModel(await models.runtime(), "mygw/deepseek-v3").baseUrl).toBe("http://fixed.internal:8000/v1");
      // With nothing read before, there is nothing to keep: a start on a broken file fails.
      await writeFile(join(dir, "models.json"), "{ not json");
      await expect(agentModels(dir, { authPath: join(dir, "auth.json") }).createRuntime()).rejects.toThrow(
        join(dir, "models.json"),
      );
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the machine's models.json (~/.fastagent/models.json), under the agent's own", () => {
  afterEach(() => vi.unstubAllEnvs());

  const endpoint = (baseUrl: string, extra: Record<string, unknown> = {}) => ({
    baseUrl,
    api: "openai-completions",
    models: [{ id: "m" }],
    ...extra,
  });

  /** A machine file at a temporary path (FASTAGENT_MODELS_PATH), and an agent dir with an optional file of its own. */
  async function layers(
    machine: string,
    own?: string,
  ): Promise<{ agentDir: string; machinePath: string; authPath: string }> {
    const root = await mkdtemp(join(tmpdir(), "fa-machine-models-"));
    const machinePath = join(root, "machine-models.json");
    await writeFile(machinePath, machine);
    vi.stubEnv("FASTAGENT_MODELS_PATH", machinePath);
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "fastagent.config.ts"), "export default {};");
    if (own !== undefined) await writeFile(join(agentDir, "models.json"), own);
    return { agentDir, machinePath, authPath: join(root, "auth.json") };
  }

  it("a machine endpoint resolves for an agent with no models.json, its key from a stored credential", async () => {
    // No apiKey in the file: pi's schema allows that when auth.json provides it, which is how a client stores a key.
    const { agentDir, authPath } = await layers(
      JSON.stringify({ providers: { localgw: endpoint("http://127.0.0.1:8000/v1") } }),
    );
    await writeFile(authPath, JSON.stringify({ localgw: { type: "api_key", key: "sk-stored" } }));

    const models = await createPiModelRuntime({ agentDir, credentials: fastagentCredentialStore(authPath) });

    expect(resolveModel(models, "localgw/m").baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(await probeAuthSource(models, "localgw/m")).toBe("stored credential");
  });

  it("the agent's own models.json wins a provider id; the machine's other providers stay", async () => {
    const machine = JSON.stringify({
      providers: {
        localgw: endpoint("http://machine:8000/v1", { apiKey: "x" }),
        other: endpoint("http://other/v1", { apiKey: "x" }),
      },
    });
    const own = JSON.stringify({ providers: { localgw: endpoint("https://pinned.example.com/v1", { apiKey: "x" }) } });
    const { agentDir, authPath } = await layers(machine, own);

    const models = await createPiModelRuntime({ agentDir, credentials: fastagentCredentialStore(authPath) });

    expect(resolveModel(models, "localgw/m").baseUrl).toBe("https://pinned.example.com/v1");
    expect(resolveModel(models, "other/m").baseUrl).toBe("http://other/v1");
    expect(await machineModels(agentDir)).toMatchObject({ inherited: ["other"], overridden: ["localgw"] });
  });

  it("serving and the report read the machine file the same way: a file one rejects, both reject", async () => {
    // A file pi alone would accept (comments) but the merge cannot read must not load for dev while `info` and
    // `deploy` fail on it: both go through one reader.
    const commented = `{ // the machine's gateway\n "providers": { "localgw": ${JSON.stringify(endpoint("http://m/v1", { apiKey: "x" }))} } }`;
    const { agentDir, machinePath, authPath } = await layers(commented);
    await expect(createPiModelRuntime({ agentDir, credentials: fastagentCredentialStore(authPath) })).rejects.toThrow(
      machinePath,
    );
    await expect(machineModels(agentDir)).rejects.toThrow(machinePath);
  });

  it("the merge is a content-addressed snapshot in fastagent's home: shared, never rewritten, never pulled away", async () => {
    // pi re-reads its models file on every refresh, and several processes open the same agent: a snapshot one of them
    // rewrote would change what another's refresh reads, and one pruned would silently empty it.
    const { agentDir, machinePath, authPath } = await layers(
      JSON.stringify({ providers: { localgw: endpoint("http://m/v1", { apiKey: "x" }) } }),
    );
    const cache = join(homedir(), ".fastagent", ".cache", "models");
    const before = new Set(await readdir(cache).catch(() => []));
    const snapshots = async () => (await readdir(cache)).filter((name) => !before.has(name));

    await createPiModelRuntime({ agentDir, credentials: fastagentCredentialStore(authPath) });
    const [first] = await snapshots();
    const created = await stat(join(cache, first as string));
    expect((created.mode & 0o777).toString(8)).toBe("600");

    await createPiModelRuntime({ agentDir, credentials: fastagentCredentialStore(authPath) }); // same content: the same snapshot, untouched
    expect(await snapshots()).toEqual([first]);
    expect((await stat(join(cache, first as string))).mtimeMs).toBe(created.mtimeMs);

    await writeFile(
      machinePath,
      JSON.stringify({ providers: { localgw: endpoint("http://changed/v1", { apiKey: "x" }) } }),
    );
    const changed = await createPiModelRuntime({ agentDir, credentials: fastagentCredentialStore(authPath) });
    expect(resolveModel(changed, "localgw/m").baseUrl).toBe("http://changed/v1");
    expect(await snapshots()).toHaveLength(2); // a new snapshot; the one a running process reads stays
  });

  it("a running agent reads an edit of the MACHINE's file too", async () => {
    const { agentDir, machinePath, authPath } = await layers(
      JSON.stringify({ providers: { localgw: endpoint("http://m/v1", { apiKey: "x" }) } }),
    );
    const models = agentModels(agentDir, { authPath });
    expect((await models.runtime()).getModel("localgw", "added")).toBeUndefined();
    await writeFile(
      machinePath,
      JSON.stringify({
        providers: { localgw: { ...endpoint("http://m/v1", { apiKey: "x" }), models: [{ id: "m" }, { id: "added" }] } },
      }),
    );
    expect((await models.runtime()).getModel("localgw", "added")).toBeDefined();
  });

  it("a model file that cannot even be stat'ed keeps the models read before, and is said once", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-machine-unreadable-"));
    const machineDir = join(root, "machine");
    await mkdir(machineDir);
    await writeFile(
      join(machineDir, "models.json"),
      JSON.stringify({ providers: { localgw: endpoint("http://m/v1", { apiKey: "x" }) } }),
    );
    vi.stubEnv("FASTAGENT_MODELS_PATH", join(machineDir, "models.json"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
    const models = agentModels(agentDir, { authPath: join(root, "auth.json") });
    await models.runtime();
    // The machine file's directory becomes a file: its stat fails with ENOTDIR, not "absent".
    await rm(machineDir, { recursive: true });
    await writeFile(machineDir, "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) expect(resolveModel(await models.runtime(), "localgw/m").baseUrl).toBe("http://m/v1");
      expect(errors.mock.calls.filter((call) => /cannot be used/.test(call.join(" ")))).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("a malformed machine file fails startup naming that file, alone or merged", async () => {
    for (const own of [undefined, JSON.stringify({ providers: {} })]) {
      const { agentDir, machinePath, authPath } = await layers("{ not json", own);
      await expect(createPiModelRuntime({ agentDir, credentials: fastagentCredentialStore(authPath) })).rejects.toThrow(
        machinePath,
      );
    }
  });
});

describe("models.json on the serving path (createPiAgentFromDir)", () => {
  it("dev/start/invoke assemble against a models.json endpoint, and leave no generated file in the agent dir", async () => {
    // The Phase-2 claim: the SERVING opener — not just `chat` — resolves a custom endpoint. Before this,
    // the opener ran on pi-ai's builtinModels(), which cannot see models.json, so assembly died with
    // `unknown model "mygw/deepseek-v3"` no matter what the file said.
    const dir = await mkdtemp(join(tmpdir(), "fastagent-serving-modelsjson-"));
    await writeFile(join(dir, "fastagent.config.ts"), `export default { model: "mygw/deepseek-v3" };`);
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          mygw: {
            baseUrl: "http://vllm.internal:8000/v1",
            api: "openai-completions",
            apiKey: "$FASTAGENT_TEST_GW_KEY",
            models: [{ id: "deepseek-v3" }],
          },
        },
      }),
    );

    const { agent, modelSpec, stateRoot } = await createPiAgentFromDir(dir);
    expect(agent).toBeDefined();
    expect(modelSpec).toBe("mygw/deepseek-v3");

    // The agent dir holds AUTHORED files only. L2 does not pass stateRoot explicitly, so this also pins
    // that its default derivation keeps pi's catalog cache out of what `deploy` bakes into the image.
    expect(existsSync(join(dir, "models-store.json"))).toBe(false);
    expect(stateRoot.startsWith(dir)).toBe(true);
  });
});

describe("models.json while the agent runs (session control)", () => {
  it("a model added to models.json is listed, accepted and resolved without reopening the agent; one removed is not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fastagent-live-modelsjson-"));
    const gateway = (ids: string[]) =>
      JSON.stringify({
        providers: {
          mygw: {
            baseUrl: "http://gw.invalid/v1",
            api: "openai-completions",
            apiKey: "x",
            models: ids.map((id) => ({ id })),
          },
        },
      });
    await writeFile(join(dir, "fastagent.config.ts"), `export default { model: "mygw/a" };`);
    await writeFile(join(dir, "models.json"), gateway(["a"]));
    const { sessionControl } = await createPiAgentFromDir(dir, { sessionControl: true });
    const listed = async () =>
      (await sessionControl!.models()).map((m) => m.spec).filter((spec) => spec.startsWith("mygw/"));
    expect(await listed()).toEqual(["mygw/a"]);

    await writeFile(join(dir, "models.json"), gateway(["a", "b"]));
    expect(await listed()).toEqual(["mygw/a", "mygw/b"]);
    expect(await sessionControl!.sessions.get("s").update({ model: "mygw/b" })).toEqual({ ok: true });
    expect((await sessionControl!.sessions.get("s").state()).model).toBe("mygw/b");

    // Removed: no longer offered for a new selection.
    await writeFile(join(dir, "models.json"), gateway(["a"]));
    expect(await listed()).toEqual(["mygw/a"]);
    expect((await sessionControl!.sessions.get("t").update({ model: "mygw/b" })).ok).toBe(false);
  });

  it("a default the files never resolved holds no edit back: there was nothing a turn could run on to keep", async () => {
    // A ChatGPT model resolves only after its sign-in, so an agent can open on one before it.
    const dir = await mkdtemp(join(tmpdir(), "fastagent-live-modelsjson-nodefault-"));
    const gateway = (ids: string[]) =>
      JSON.stringify({
        providers: {
          mygw: {
            baseUrl: "http://gw.invalid/v1",
            api: "openai-completions",
            apiKey: "x",
            models: ids.map((id) => ({ id })),
          },
        },
      });
    await writeFile(join(dir, "models.json"), gateway(["a"]));
    const models = agentModels(dir, { authPath: join(dir, "auth.json") }, { keepsModel: "openai-codex/gpt-5.4" });
    await models.runtime();
    await writeFile(join(dir, "models.json"), gateway(["a", "b"]));
    expect((await models.runtime()).getModel("mygw", "b")).toBeDefined();
  });

  it("an edit that drops the default model is refused like one that does not load: the turns keep running", async () => {
    // Valid JSON, but the provider renamed: every turn on the default would fail, the agent's own included.
    const dir = await mkdtemp(join(tmpdir(), "fastagent-live-modelsjson-default-"));
    const gateway = (id: string) =>
      JSON.stringify({
        providers: {
          [id]: { baseUrl: "http://gw.invalid/v1", api: "openai-completions", apiKey: "x", models: [{ id: "a" }] },
        },
      });
    await writeFile(join(dir, "fastagent.config.ts"), `export default { model: "mygw/a" };`);
    await writeFile(join(dir, "models.json"), gateway("mygw"));
    const { sessionControl } = await createPiAgentFromDir(dir, { sessionControl: true });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(join(dir, "models.json"), gateway("othergw"));
      for (let i = 0; i < 2; i++) {
        expect((await sessionControl!.sessions.get("s").state()).model).toBe("mygw/a");
        expect((await sessionControl!.models()).map((m) => m.spec)).toContain("mygw/a");
      }
      const said = errors.mock.calls.map((call) => call.join(" ")).filter((line) => /cannot be used/.test(line));
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/no longer define the default model "mygw\/a"/);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("authStatus: the one answer to what authenticates a provider for an agent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const oauth = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
  /** An agent dir whose credentials file holds `stored` (the file is the only layer, as on a deployed box). */
  async function agentStoring(stored: Record<string, unknown>) {
    const agentDir = await mkdtemp(join(tmpdir(), "fa-auth-status-"));
    const path = join(agentDir, "auth.json");
    await writeFile(path, JSON.stringify(stored));
    return { models: agentModels(agentDir, { authPath: path }), path };
  }

  it("a live stored login, or nothing: what the startup report and a box's --if-missing both read", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    const empty = await agentStoring({});
    expect(await empty.models.authStatus("anthropic")).toEqual({ path: empty.path });
    const held = await agentStoring({ anthropic: oauth });
    expect(await held.models.authStatus("anthropic")).toEqual({
      path: held.path,
      source: "OAuth",
      stored: "oauth",
    });
  });

  it("an expired login whose refresh the provider refuses is on file but authenticates nothing", async () => {
    const dir = await agentStoring({ "openai-codex": { ...oauth, refresh: "revoked", expires: 1 } });
    const refresh = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 401 }));
    vi.stubGlobal("fetch", refresh);
    expect(await dir.models.authStatus("openai-codex")).toEqual({
      path: dir.path,
      stored: "oauth",
      error: expect.stringContaining("401"),
    });
    expect(refresh).toHaveBeenCalled(); // it asked the provider, rather than trusting the file
  });

  it("a key in the environment authenticates with nothing on file, and goes unused beside a stored login", async () => {
    // A platform variable (`fly secrets set …`), or a key added to the value file after the box was logged in: pi lets
    // the stored credential own its provider, which is the case a deployment needs spelled out.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-from-the-environment");
    const bare = await agentStoring({});
    expect(await bare.models.authStatus("anthropic")).toEqual({
      path: bare.path,
      source: "ANTHROPIC_API_KEY",
    });
    const held = await agentStoring({ anthropic: oauth });
    expect(await held.models.authStatus("anthropic")).toEqual({
      path: held.path,
      source: "OAuth",
      stored: "oauth",
      shadowed: "ANTHROPIC_API_KEY",
    });
  });
});

describe("the model catalogs: the agent's own over the machine's", () => {
  it("layers chat, image, and classifier entries independently when their IDs match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-model-types-"));
    const entry = (models: object[]) => ({ anthropic: { lastModified: Date.now() + 86_400_000, models } });
    await mkdir(dirname(globalCatalogPath()), { recursive: true });
    await writeFile(
      globalCatalogPath(),
      JSON.stringify(
        entry([
          { id: "same", name: "machine chat" },
          { id: "same", type: "classifier", name: "classifier" },
        ]),
      ),
    );
    await writeFile(
      join(dir, "models-store.json"),
      JSON.stringify(
        entry([
          { id: "same", type: "chat", name: "agent chat" },
          { id: "same", type: "image", name: "image" },
        ]),
      ),
    );
    try {
      const files = await modelRuntimeFiles({ agentDir: dir });
      const { modelsStore } = await files.create();
      if (!modelsStore) throw new Error("expected a read-only catalog store");
      expect((await modelsStore.read("anthropic"))!.models.map((model) => model.name).sort()).toEqual([
        "agent chat",
        "classifier",
        "image",
      ]);
    } finally {
      await rm(globalCatalogPath(), { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("layers by model id, the agent winning, and drops an entry pi would ignore before the merge", async () => {
    const bundled = createPiModels().getProvider("anthropic")?.getModels()[0] as Model<Api>;
    const later = Date.now() + 86_400_000;
    const model = (id: string, name: string): Model<Api> => ({ ...bundled, id, name });
    const dir = await mkdtemp(join(tmpdir(), "fastagent-catalogs-"));
    await mkdir(dirname(globalCatalogPath()), { recursive: true });
    const machine = { models: [model("claude-held", "held"), model("claude-both", "machine's")], lastModified: later };
    await writeFile(globalCatalogPath(), JSON.stringify({ anthropic: machine }));
    // The agent's file holds a newer model and an entry no newer than pi's bundled catalog: pi ignores the stale one,
    // and merging must not let it ride the machine entry's date.
    const own = { models: [model("claude-both", "agent's"), model("claude-own", "own")], lastModified: later };
    await writeFile(
      join(dir, "models-store.json"),
      JSON.stringify({ anthropic: own, openai: { models: [model("gpt-stale", "stale")], lastModified: 1 } }),
    );
    const staleUnderNewer = { anthropic: { models: [model("claude-stale", "stale")], lastModified: 1 } };
    const staleDir = await mkdtemp(join(tmpdir(), "fastagent-catalogs-stale-"));
    await writeFile(join(staleDir, "models-store.json"), JSON.stringify(staleUnderNewer));
    try {
      const credentials = new InMemoryCredentialStore();
      const here = await createPiModelRuntime({ agentDir: dir, credentials });
      expect(here.getModel("anthropic", "claude-held")?.name).toBe("held");
      expect(here.getModel("anthropic", "claude-own")?.name).toBe("own");
      expect(here.getModel("anthropic", "claude-both")?.name).toBe("agent's");
      expect(
        (await createPiModelRuntime({ agentDir: staleDir, credentials })).getModel("anthropic", "claude-stale"),
      ).toBeUndefined();
      // Deployed: the agent's file ships, the machine's does not.
      const deployed = await createPiModelRuntime({ agentDir: dir, credentials, machineLayer: false });
      expect(deployed.getModel("anthropic", "claude-own")).toBeDefined();
      expect(deployed.getModel("anthropic", "claude-held")).toBeUndefined();
    } finally {
      await rm(globalCatalogPath(), { force: true });
    }
  });

  it("PI_OFFLINE refuses before the runtime is built, so a runtime that cannot be built fails nowhere unheard", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    const build = vi.fn(async (): Promise<ModelRuntime> => {
      throw new Error("Failed to parse models.json");
    });
    try {
      await expect(refreshCatalog(join(tmpdir(), "fa-offline-catalog.json"), build)).rejects.toThrow(/PI_OFFLINE/);
      expect(build).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a refresh with no usable credential anywhere is refused instead of reporting a refresh that asked for nothing", async () => {
    const refresh = vi.fn();
    const runtime = {
      getProviders: () => [{ id: "anthropic", refreshModels: async () => {} }, { id: "static" }],
      checkAuth: async () => undefined,
      refresh,
    } as unknown as ModelRuntime;
    await expect(refreshCatalog(join(tmpdir(), "fa-no-catalog.json"), async () => runtime)).rejects.toThrow(
      /no provider has a usable credential/,
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
