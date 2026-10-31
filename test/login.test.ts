import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type Credential,
  InMemoryCredentialStore,
  type Provider,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import { SignInCancelled } from "../src/sign-in-api.ts";
import * as models from "../src/harnesses/models/models.ts";
import { GLOBAL_AUTH_PATH, fastagentCredentialStore } from "../src/harnesses/models/credentials.ts";
import {
  type IoOption,
  type LoginIO,
  LoginRefused,
  PI_DEFAULT_MODELS,
  chooseLogin,
  loginFlow,
  loginOptionsOver,
  loginOver,
  loginStatusText,
} from "../src/harnesses/models/login.ts";

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
  opts: { oauth?: boolean; apiKeyLogin?: boolean; onOauthLogin?: (cb: AuthInteraction) => Promise<Credential> } = {},
): Provider {
  return {
    id,
    name: id,
    // A real provider always lists its models; none here, so an entered key's check reports "unknown".
    getModels: () => [],
    auth: {
      oauth: opts.oauth ? { name: `${id} (OAuth)`, login: opts.onOauthLogin ?? (async () => OAUTH_CRED) } : undefined,
      apiKey: opts.apiKeyLogin
        ? {
            name: `${id} API key`,
            resolve: async () => undefined,
            login: async (cb: AuthInteraction): Promise<Credential> => ({
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
  it("persists one device ID beside the credentials and gives another installation its own", async () => {
    const ids: string[] = [];
    const provider = fakeProvider("device", { oauth: true });
    provider.auth.oauth!.login = async (_io, options) => {
      const id = options?.getDeviceId?.();
      if (!id) throw new Error("device ID required");
      ids.push(id);
      return OAUTH_CRED;
    };
    const path = await tmpAuth();
    for (const authPath of [path, path, await tmpAuth()]) {
      await loginOver(
        { provider: "device", method: "oauth", authPath, interaction: { prompt: async () => "", notify: () => {} } },
        { providers: [provider] },
      );
    }
    expect(ids[0]).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });
  it("over a caller's credential store, writes no device ID file and passes none", async () => {
    let seen: string | undefined = "unset";
    const provider = fakeProvider("device", { oauth: true });
    provider.auth.oauth!.login = async (_io, options) => {
      seen = options?.getDeviceId?.();
      return OAUTH_CRED;
    };
    const credentialStore = new InMemoryCredentialStore();
    await loginOver(
      {
        provider: "device",
        method: "oauth",
        credentialStore,
        interaction: { prompt: async () => "", notify: () => {} },
      },
      { providers: [provider] },
    );
    expect(seen).toBeUndefined();
    expect(existsSync(join(dirname(GLOBAL_AUTH_PATH), "settings.json"))).toBe(false);
    expect(await credentialStore.read("device")).toMatchObject({ type: "oauth" });
  });
  it("refuses OAuth when the device ID cannot be persisted", async () => {
    const authPath = await tmpAuth();
    await mkdir(join(dirname(authPath), "device.json"));
    const flow = vi.fn(async () => OAUTH_CRED);
    const provider = fakeProvider("device", { oauth: true, onOauthLogin: flow });
    await expect(
      loginOver(
        { provider: "device", method: "oauth", authPath, interaction: { prompt: async () => "", notify: () => {} } },
        { providers: [provider] },
      ),
    ).rejects.toThrow("could not persist login device ID");
    expect(flow).not.toHaveBeenCalled();
  });

  it("a single-method provider auto-runs that method (oauth) and persists {type:oauth}", async () => {
    const path = await tmpAuth();
    const res = await loginFlow(fakeIO().io, {
      provider: "codex",
      providers: PROVIDERS,
      authPath: path,
    });
    expect(res).toEqual({ provider: "codex", method: "oauth", verified: "n/a" });
    expect((await readAuth(path)).codex).toMatchObject({ type: "oauth", access: "tok" });
  });

  it("an api-key provider prompts (hidden) and persists {type:api_key}", async () => {
    const path = await tmpAuth();
    const res = await loginFlow(fakeIO({ prompt: ["sk-123"] }).io, {
      provider: "openai",
      providers: PROVIDERS,
      authPath: path,
    });
    expect(res).toEqual({ provider: "openai", method: "api_key", verified: "unknown" });
    expect((await readAuth(path)).openai).toEqual({ type: "api_key", key: "sk-123" });
  });

  it("a dual-method provider asks which method, then runs it", async () => {
    const path = await tmpAuth();
    const res = await loginFlow(fakeIO({ select: ["api_key"], prompt: ["sk-a"] }).io, {
      provider: "anthropic",
      providers: PROVIDERS,
      authPath: path,
    });
    expect(res).toEqual({ provider: "anthropic", method: "api_key", verified: "unknown" });
    expect((await readAuth(path)).anthropic).toEqual({ type: "api_key", key: "sk-a" });
  });

  it("no args → method select then provider select (filtered to that method)", async () => {
    const path = await tmpAuth();
    const { io, shown } = fakeIO({ select: ["oauth", "anthropic"] });
    const res = await loginFlow(io, { providers: PROVIDERS, authPath: path });
    expect(res).toEqual({ provider: "anthropic", method: "oauth", verified: "n/a" });
    // of the test's providers, the picker listed only the oauth-capable ones (anthropic, codex), NOT key-only openai
    const ours = new Set(PROVIDERS.map((p) => p.id));
    expect(
      shown[1]
        ?.map((o) => o.value)
        .filter((id) => ours.has(id))
        .sort(),
    ).toEqual(["anthropic", "codex"]);
  });

  it("the provider picker shows configured status from the store", async () => {
    const path = await tmpAuth();
    const store = fastagentCredentialStore(path);
    await store.modify("anthropic", async () => OAUTH_CRED); // pre-configure
    const { io, shown } = fakeIO({ select: ["oauth", "codex"] });
    await loginFlow(io, { providers: PROVIDERS, authPath: path });
    // On every row, as pi writes it, not only the one a cursor is on.
    expect(shown[1]?.find((o) => o.value === "anthropic")?.label).toBe("anthropic ✓ configured");
    expect(shown[1]?.find((o) => o.value === "codex")?.label).toBe("codex • not configured");
  });

  it("the status is what the agent reads, which can hold more than the file a sign-in writes", async () => {
    const reads = new InMemoryCredentialStore();
    await reads.modify("codex", async () => OAUTH_CRED);
    const { io, shown } = fakeIO({ select: ["oauth", undefined] });
    await expect(loginFlow(io, { providers: PROVIDERS, authPath: await tmpAuth(), statusFrom: reads })).rejects.toThrow(
      SignInCancelled,
    );
    expect(shown[1]?.find((o) => o.value === "codex")?.label).toBe("codex ✓ configured");
  });

  it("an empty provider selection is a cancel", async () => {
    await expect(
      loginFlow(fakeIO({ select: ["oauth", undefined] }).io, {
        providers: PROVIDERS,
        authPath: await tmpAuth(),
      }),
    ).rejects.toThrow(SignInCancelled);
  });

  it("asks as pi's /login asks: how to sign in, then the provider by name, in name order", async () => {
    const { io, shown } = fakeIO({ select: ["api_key", undefined] });
    await expect(loginFlow(io, { authPath: await tmpAuth() })).rejects.toThrow(SignInCancelled);
    expect(shown[0]).toEqual([
      { value: "oauth", label: "Sign in with an account" },
      { value: "api_key", label: "Sign in with an API key" },
      { value: "radius", label: "Sign in with Radius • not configured" },
    ]);
    const names = shown[1]?.map(({ label }) => label) ?? [];
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(shown[1]?.find(({ value }) => value === "openai")?.label).toMatch(/^OpenAI (✓|•) /);
  });

  it("names the legacy provider as pi does, so the ChatGPT sign-in is the one called OpenAI", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { io, shown } = fakeIO({ select: ["oauth", undefined] });
    await expect(loginFlow(io, { authPath: await tmpAuth() })).rejects.toThrow(SignInCancelled);
    expect(shown[1]?.filter(({ value }) => value.startsWith("openai")).map(({ label }) => label)).toEqual([
      "OpenAI • not configured",
      "OpenAI Codex (legacy) • not configured",
    ]);
  });

  it("each sign-in says what authenticates its provider now, a stored credential outranking the environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    const offered = await loginOptionsOver(
      await tmpAuth(JSON.stringify({ anthropic: { type: "api_key", key: "sk" } })),
    );
    const status = (provider: string, method: string) =>
      loginStatusText(offered.find((o) => o.provider === provider && o.method === method) as never);
    expect(status("anthropic", "api_key")).toBe("✓ configured");
    expect(status("anthropic", "oauth")).toBe("API key configured");
    expect(status("openai", "api_key")).toBe("✓ env: OPENAI_API_KEY");
    expect(status("openai-codex", "oauth")).toBe("not configured");
    // What answers once the stored one is gone, beside the status it does not decide.
    const anthropic = offered.find((o) => o.provider === "anthropic" && o.method === "api_key");
    expect(anthropic).toMatchObject({ status: { source: "stored credential" }, environment: "ANTHROPIC_API_KEY" });
    expect(offered.find((o) => o.provider === "openai-codex")?.environment).toBeUndefined();
  });

  it("a provider is named by its id or, as pi takes it, by its name", async () => {
    const named = { ...fakeProvider("gw", { apiKeyLogin: true }), name: "My Gateway" } as Provider;
    const authPath = await tmpAuth();
    const { io } = fakeIO({ prompt: ["sk-gw"] });
    await loginFlow(io, { providers: [named], provider: "my gateway", authPath });
    expect((await readAuth(authPath)).gw).toEqual({ type: "api_key", key: "sk-gw" });
  });

  it("a provider named by its id or its name, offering both, is asked how with its own label", async () => {
    const { io, shown } = fakeIO({ select: [undefined] });
    await expect(loginFlow(io, { provider: "OpenAI", authPath: await tmpAuth() })).rejects.toThrow(SignInCancelled);
    expect(shown[0]).toEqual([
      { value: "oauth", label: "Sign in with ChatGPT" },
      { value: "api_key", label: "Sign in with an API key" },
    ]);
  });

  it("without menus, a choice not given is refused, naming how to give it and the sign-ins to choose from", async () => {
    const offered = await loginOptionsOver(await tmpAuth(), PROVIDERS);
    const refused = async (given: { provider?: string; method?: "oauth" | "api_key" }) => {
      const error = await chooseLogin(offered, given, undefined).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      if (!(error instanceof LoginRefused)) throw new Error(`not refused: ${String(error)}`);
      return { message: error.message, choices: error.choices.map((o) => `${o.provider}:${o.method}`) };
    };
    const unnamed = await refused({});
    expect(unnamed.message).toMatch(/^name the provider to sign in to \(one of .*codex.*openai/);
    expect(unnamed.choices).toEqual(offered.map((o) => `${o.provider}:${o.method}`));
    expect(await refused({ provider: "anthropic" })).toEqual({
      message: "anthropic signs in with an account or an API key: pass --method account or --method api-key",
      choices: ["anthropic:oauth", "anthropic:api_key"],
    });
    expect((await refused({ provider: "nope" })).message).toMatch(/^unknown provider "nope": one of /);
    expect(await refused({ provider: "codex", method: "api_key" })).toEqual({
      message: "codex signs in only with an account",
      choices: ["codex:oauth"],
    });
    expect((await refused({ method: "api_key" })).choices).toEqual(
      offered.filter((o) => o.method === "api_key").map((o) => `${o.provider}:${o.method}`),
    );
  });

  it("a provider whose key comes only from the environment says so, and signs in to nothing", async () => {
    const ambient = { ...fakeProvider("ambient"), name: "Ambient", auth: { apiKey: { name: "Ambient key" } } };
    const { io } = fakeIO({ select: ["api_key", "ambient"] });
    await expect(loginFlow(io, { providers: [ambient as Provider], authPath: await tmpAuth() })).rejects.toThrow(
      "Ambient is configured outside fastagent: set its key in the environment",
    );
  });

  it("an empty API key fails visibly and persists no credential", async () => {
    const path = await tmpAuth();
    await expect(
      loginFlow(fakeIO({ prompt: [undefined] }).io, {
        provider: "openai",
        providers: PROVIDERS,
        authPath: path,
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
    await expect(loginFlow(fakeIO().io, { provider: "codex", providers, authPath: path })).rejects.toThrow(
      /corrupt auth file/,
    );
    expect(ran).toBe(false); // preflight threw before the flow — no wasted round-trip
  });

  // #58 invariant: the persist write AFTER a successful flow must fail visibly, never a false success.
  // The failure is injected by occupying the atomic write's temp path with a DIRECTORY: the preflight
  // passes (it reads and locks but writes nothing) and the flow runs, then the persist write cannot
  // create its temp file. Not a read-only auth.json — the write publishes by rename, which needs the
  // parent directory's write bit and not the target file's, so 0444 no longer stops one.
  it("a persist write failure after a successful flow rejects, persisting nothing", async () => {
    const path = await tmpAuth(JSON.stringify({ existing: { type: "api_key", key: "x" } }));
    await mkdir(`${path}.tmp`);
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
    await expect(loginFlow(fakeIO().io, { provider: "codex", providers, authPath: path })).rejects.toThrow(
      /EISDIR|directory/i,
    );
    expect(ran).toBe(true); // got past preflight + flow; only the persist write failed
    expect((await readAuth(path)).codex).toBeUndefined(); // no false success
    expect((await readAuth(path)).existing).toBeDefined(); // and the file it could not replace is intact
  });

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
    await expect(loginFlow(io, { provider: "codex", providers, authPath: await tmpAuth() })).resolves.toEqual({
      provider: "codex",
      method: "oauth",
      verified: "n/a",
    });
    expect(aborted).toBe(true); // `done` backstop cancelled the pending prompt
  });
});

describe("login (the entry point any front end drives with pi-ai's AuthInteraction)", () => {
  afterEach(() => vi.restoreAllMocks());
  /** A client: answers prompts from a script, records what it was shown and told. */
  function client(answers: string[], signal?: AbortSignal) {
    const prompts: AuthPrompt[] = [];
    const events: AuthEvent[] = [];
    const interaction: AuthInteraction = {
      ...(signal ? { signal } : {}),
      prompt: async (prompt) => {
        prompts.push(prompt);
        const answer = answers.shift();
        if (answer !== undefined) return answer;
        // Nothing scripted: wait, as a person would, until the prompt is withdrawn.
        return new Promise<string>((_resolve, reject) => {
          prompt.signal?.addEventListener("abort", () => reject(new Error("prompt withdrawn")));
        });
      },
      notify: (event) => void events.push(event),
    };
    return { interaction, prompts, events };
  }

  /**
   * A faux provider whose API-key login asks a region (select), then the key (secret). `statuses` are the HTTP
   * statuses its requests report in turn (faux itself always reports 200): a 401 is how a real provider rejects a key.
   */
  function keyedFaux(
    responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
    statuses: number[] = [],
    models?: { id: string }[],
  ): Provider {
    const faux = fauxProvider({ provider: "keyed", ...(models ? { models } : {}) });
    faux.setResponses(responses);
    type Options = {
      onResponse?: (response: { status: number; headers: Record<string, string> }, model: unknown) => unknown;
    };
    const reporting = (options: Options | undefined): Options => {
      const status = statuses.shift();
      return {
        ...options,
        onResponse: (response, model) =>
          options?.onResponse?.({ ...response, status: status ?? response.status }, model),
      };
    };
    const base = faux.provider as unknown as Record<string, (...args: unknown[]) => unknown>;
    return {
      ...faux.provider,
      stream: (model: unknown, context: unknown, options?: Options) =>
        base.stream?.(model, context, reporting(options)),
      streamSimple: (model: unknown, context: unknown, options?: Options) =>
        base.streamSimple?.(model, context, reporting(options)),
      auth: {
        apiKey: {
          name: "Keyed API key",
          login: async (interaction: AuthInteraction): Promise<Credential> => {
            const region = await interaction.prompt({
              type: "select",
              message: "Region",
              options: [
                { id: "eu", label: "EU" },
                { id: "us", label: "US" },
              ],
            });
            const key = await interaction.prompt({ type: "secret", message: "API key" });
            return { type: "api_key", key, env: { REGION: region } };
          },
          resolve: async ({ credential }: { credential?: Credential }) =>
            credential?.type === "api_key" && credential.key
              ? { auth: { apiKey: credential.key }, source: "stored credential" }
              : undefined,
        },
      },
    } as unknown as Provider;
  }

  it("a select → secret flow persists, and the key is verified through notify", async () => {
    const authPath = await tmpAuth();
    const { interaction, prompts, events } = client(["eu", "sk-good"]);

    const result = await loginOver(
      {
        provider: "keyed",
        method: "api_key",
        authPath,
        interaction,
      },
      { providers: [keyedFaux([fauxAssistantMessage("pong")])] },
    );

    expect(result).toEqual({ provider: "keyed", method: "api_key", verified: "ok" });
    expect(prompts.map((p) => p.type)).toEqual(["select", "secret"]); // pi-ai's prompt types reach the client as-is
    expect((await readAuth(authPath)).keyed).toEqual({ type: "api_key", key: "sk-good", env: { REGION: "eu" } });
    expect(events.map((e) => e.type)).toEqual(["progress", "info"]);
  });

  it("the copied default-model table is pi's own: a pi release that changes a default fails here", async () => {
    // pi does not export `defaultModelPerProvider`, so login.ts copies it. Its file, read by path, is the check.
    const url = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js", import.meta.url);
    const pi = (await import(url.href)) as { defaultModelPerProvider: Record<string, string> };
    expect(PI_DEFAULT_MODELS).toEqual(pi.defaultModelPerProvider);
  });

  it("a built-in provider's key is verified with pi's default model, not the alphabetically first", async () => {
    // google's catalog opens with a Deep Research preview model, which a minimal request may not reach.
    const { interaction, events } = client(["sk-google"]);
    const probe = vi.spyOn(models, "probeApiKey").mockResolvedValue({ state: "ok" });
    await loginOver({ provider: "google", method: "api_key", authPath: await tmpAuth(), interaction });
    expect(probe.mock.calls[0]?.[1]).toMatchObject({ provider: "google", id: PI_DEFAULT_MODELS.google });
    expect(events.find((e) => e.type === "progress")?.message).toContain(`google/${PI_DEFAULT_MODELS.google}`);
  });

  it("the key is verified with the model the picker chose, when login's registry has it; else the first", async () => {
    const models = [{ id: "a-preview-only" }, { id: "chosen" }];
    const probed = async (verifyWith: string | undefined) => {
      const { interaction, events } = client(["eu", "sk"]);
      await loginOver(
        { provider: "keyed", method: "api_key", authPath: await tmpAuth(), interaction },
        { providers: [keyedFaux([fauxAssistantMessage("pong")], [], models)], ...(verifyWith ? { verifyWith } : {}) },
      );
      return events.find((e) => e.type === "progress")?.message;
    };

    expect(await probed("keyed/chosen")).toMatch(/keyed\/chosen/);
    // Only in the agent's models.json, or another provider's: the provider's own first model answers instead.
    expect(await probed("keyed/only-in-models-json")).toMatch(/keyed\/a-preview-only/);
    expect(await probed("anthropic/claude-sonnet-4-5")).toMatch(/keyed\/a-preview-only/);
    expect(await probed(undefined)).toMatch(/keyed\/a-preview-only/);
  });

  it("a key the provider rejects (401) is never stored, and the provider's key flow runs again", async () => {
    const authPath = await tmpAuth();
    const rejected = fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "401 Unauthorized: invalid x-api-key",
    });
    const { interaction, prompts } = client(["eu", "sk-bad", "eu", "sk-good"]);

    const result = await loginOver(
      {
        provider: "keyed",
        method: "api_key",
        authPath,
        interaction,
      },
      { providers: [keyedFaux([rejected, fauxAssistantMessage("pong")], [401, 200])] },
    );

    expect(result.verified).toBe("ok");
    expect(prompts.filter((p) => p.type === "secret")).toHaveLength(2);
    expect((await readAuth(authPath)).keyed.key).toBe("sk-good"); // the rejected key is not left behind
  });

  it("a rejected key never replaces what the file held, even when the person then cancels", async () => {
    const previous = { type: "api_key", key: "sk-previous" };
    const authPath = await tmpAuth(JSON.stringify({ keyed: previous }));
    const rejected = fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "401 Unauthorized: invalid x-api-key",
    });
    const abort = new AbortController();
    const { interaction, prompts } = client(["eu", "sk-bad"], abort.signal);
    const pending = loginOver(
      {
        provider: "keyed",
        method: "api_key",
        authPath,
        interaction,
      },
      { providers: [keyedFaux([rejected], [401])] },
    );
    await vi.waitFor(() => expect(prompts).toHaveLength(3)); // the region again: the retry has begun

    abort.abort();

    await expect(pending).rejects.toBeInstanceOf(SignInCancelled);
    expect((await readAuth(authPath)).keyed).toEqual(previous);
  });

  it("aborting while the key is being verified rejects with SignInCancelled and writes nothing", async () => {
    const authPath = await tmpAuth();
    const abort = new AbortController();
    const { interaction, events } = client(["eu", "sk-good"], abort.signal);
    // The verification request hangs until it is aborted, as a slow provider would.
    const hanging = (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
      new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
        options?.signal?.addEventListener("abort", () =>
          resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" })),
        );
      });
    const pending = loginOver(
      {
        provider: "keyed",
        method: "api_key",
        authPath,
        interaction,
      },
      { providers: [keyedFaux([hanging as never])] },
    );
    await vi.waitFor(() => expect(events.map((e) => e.type)).toContain("progress")); // "verifying the key…"

    abort.abort();

    await expect(pending).rejects.toBeInstanceOf(SignInCancelled);
    expect((await readAuth(authPath).catch(() => ({}))).keyed).toBeUndefined();
  });

  it("aborting the interaction's signal rejects with SignInCancelled and writes nothing", async () => {
    const authPath = await tmpAuth();
    const abort = new AbortController();
    const { interaction, prompts } = client([], abort.signal); // never answers: waits on the prompt's signal
    const pending = loginOver(
      { provider: "openai", method: "api_key", authPath, interaction },
      { providers: PROVIDERS },
    );
    await vi.waitFor(() => expect(prompts).toHaveLength(1));

    abort.abort();

    await expect(pending).rejects.toBeInstanceOf(SignInCancelled);
    expect((await readAuth(authPath).catch(() => ({}))).openai).toBeUndefined();
  });

  it("a prompt rejected with SignInCancelled ends the sign-in with it, whatever error the provider makes of it", async () => {
    const authPath = await tmpAuth();
    // A provider that wraps whatever its prompt rejects with, as one may.
    const wrapping = fakeProvider("codex", {
      oauth: true,
      onOauthLogin: async (cb) => {
        try {
          await cb.prompt({ type: "text", message: "Paste the code" });
        } catch (error) {
          throw new Error(`codex sign-in failed: ${(error as Error).message}`);
        }
        return OAUTH_CRED;
      },
    });
    const ask = (rejection: Error): AuthInteraction => ({
      notify: () => {},
      prompt: async () => {
        throw rejection;
      },
    });
    const backedOut = new SignInCancelled("closed the dialog");
    const request = { provider: "codex", method: "oauth" as const, authPath, getDeviceId: () => "d" };
    await expect(loginOver({ ...request, interaction: ask(backedOut) }, { providers: [wrapping] })).rejects.toBe(
      backedOut,
    );
    // Asking that failed is a failure, not a person's decision.
    await expect(
      loginOver({ ...request, interaction: ask(new Error("the window is gone")) }, { providers: [wrapping] }),
    ).rejects.toThrow("codex sign-in failed: the window is gone");
    expect((await readAuth(authPath).catch(() => ({}))).codex).toBeUndefined();
  });

  it("a prompt the provider withdraws (its callback beat manual_code) lets the flow complete", async () => {
    const authPath = await tmpAuth();
    const providers = [
      fakeProvider("codex", {
        oauth: true,
        onOauthLogin: async (cb) => {
          const manual = new AbortController();
          const typed = cb.prompt({ type: "manual_code", message: "paste the code", signal: manual.signal });
          const callback = new Promise<Credential>((resolve) => setTimeout(() => resolve(OAUTH_CRED), 5));
          const winner = await Promise.race([callback, typed.then(() => OAUTH_CRED)]);
          manual.abort(); // the callback won: withdraw the prompt
          await typed.catch(() => {});
          return winner;
        },
      }),
    ];
    const { interaction, prompts } = client([]); // the person never types the code

    const result = await loginOver({ provider: "codex", method: "oauth", authPath, interaction }, { providers });

    expect(result).toEqual({ provider: "codex", method: "oauth", verified: "n/a" });
    expect(prompts[0]?.type).toBe("manual_code");
    expect((await readAuth(authPath)).codex.type).toBe("oauth");
  });

  it("a failure after the provider withdrew a prompt is the provider's, though the withdrawn prompt read as backed out", async () => {
    const authPath = await tmpAuth();
    const providers = [
      fakeProvider("codex", {
        oauth: true,
        onOauthLogin: async (cb) => {
          const manual = new AbortController();
          const typed = cb.prompt({ type: "manual_code", message: "paste the code", signal: manual.signal });
          await new Promise((resolve) => setTimeout(resolve, 5)); // the browser's callback arrives
          manual.abort();
          await typed.catch(() => {});
          throw new Error("token exchange failed: 400 invalid_grant");
        },
      }),
    ];
    // As the terminal does: a prompt aborted under it reads as backed out.
    const interaction: AuthInteraction = {
      notify: () => {},
      prompt: (prompt) =>
        new Promise<string>((_resolve, reject) => {
          prompt.signal?.addEventListener("abort", () => reject(new SignInCancelled("cancelled")));
        }),
    };

    await expect(
      loginOver({ provider: "codex", method: "oauth", authPath, interaction, getDeviceId: () => "d" }, { providers }),
    ).rejects.toThrow("token exchange failed: 400 invalid_grant");
  });

  it("loginOptions offers each interactive method, with what the file holds for the provider", async () => {
    const authPath = await tmpAuth(JSON.stringify({ anthropic: { type: "api_key", key: "sk" } }));

    const offered = await loginOptionsOver(authPath, PROVIDERS);

    // The built-ins are always offered; the test's providers are added (replacing the built-in of the same id).
    expect(offered.some((o) => o.provider === "openai-codex")).toBe(true);
    const ours = new Set(PROVIDERS.map((p) => p.id));
    const stored = { type: "api_key", source: "stored credential" };
    const option = { external: false, subscription: false };
    expect(offered.filter((o) => ours.has(o.provider))).toEqual([
      {
        ...option,
        provider: "anthropic",
        name: "anthropic",
        method: "oauth",
        label: "Sign in with an account",
        status: stored,
      },
      {
        ...option,
        provider: "anthropic",
        name: "anthropic",
        method: "api_key",
        label: "Sign in with an API key",
        status: stored,
      },
      { ...option, provider: "codex", name: "codex", method: "oauth", label: "Sign in with an account" },
      { ...option, provider: "openai", name: "openai", method: "api_key", label: "Sign in with an API key" },
    ]);
  });

  it("a failed check of the environment is said, beside a stored credential too, which still decides the status", async () => {
    const broken = {
      id: "broken",
      name: "broken",
      getModels: () => [],
      auth: {
        apiKey: {
          name: "broken API key",
          resolve: async () => {
            throw new Error("its key command failed");
          },
          login: async (): Promise<Credential> => ({ type: "api_key", key: "k" }),
        },
      },
    } as unknown as Provider;
    const option = async (held: string) =>
      (await loginOptionsOver(await tmpAuth(held), [broken])).find((o) => o.provider === "broken") as never;
    const stored = await option(JSON.stringify({ broken: { type: "api_key", key: "sk" } }));
    // `environment` is unknown, not empty: what answers after a sign-out could not be read.
    const problem = "API key auth failed for provider broken: its key command failed";
    expect(stored).toMatchObject({ status: { source: "stored credential" }, problem });
    expect(stored).not.toHaveProperty("environment");
    expect(loginStatusText(stored)).toBe("✓ configured");
    const nothing = await option("{}");
    expect(nothing).toMatchObject({ problem });
    expect(nothing).not.toHaveProperty("status");
    expect(loginStatusText(nothing)).toBe(`auth check failed: ${problem}`);
  });

  it("loginOptions reads the credentials file once: a corrupt file warns once, not once per provider", async () => {
    const authPath = await tmpAuth("{bad");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    await loginOptionsOver(authPath);

    expect(warn.mock.calls.filter(([m]) => /corrupt auth file/.test(String(m)))).toHaveLength(1);
  });
});
