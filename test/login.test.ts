import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type Credential,
  type Provider,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import { fastagentCredentialStore } from "../src/engines/pi/auth.ts";
import {
  type IoOption,
  LoginCancelled,
  canVerifyWith,
  type LoginIO,
  login,
  loginFlow,
  loginOptions,
} from "../src/engines/pi/login.ts";

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
    expect(shown[1]?.find((o) => o.value === "anthropic")?.hint).toMatch(/configured \(oauth\)/);
    expect(shown[1]?.find((o) => o.value === "codex")?.hint).toBeUndefined(); // unconfigured
  });

  it("an empty provider selection fails visibly", async () => {
    await expect(
      loginFlow(fakeIO({ select: ["oauth", undefined] }).io, {
        providers: PROVIDERS,
        authPath: await tmpAuth(),
      }),
    ).rejects.toThrow(/no provider selected/);
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

describe("login (the entry point a GUI client drives with pi-ai's AuthInteraction)", () => {
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
  ): Provider {
    const faux = fauxProvider({ provider: "keyed" });
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

    const result = await login({
      provider: "keyed",
      method: "api_key",
      authPath,
      interaction,
      providers: [keyedFaux([fauxAssistantMessage("pong")])],
    });

    expect(result).toEqual({ provider: "keyed", method: "api_key", verified: "ok" });
    expect(prompts.map((p) => p.type)).toEqual(["select", "secret"]); // pi-ai's prompt types reach the client as-is
    expect((await readAuth(authPath)).keyed).toEqual({ type: "api_key", key: "sk-good", env: { REGION: "eu" } });
    expect(events.map((e) => e.type)).toEqual(["progress", "info"]);
  });

  it("a key the provider rejects (401) is never stored, and the provider's key flow runs again", async () => {
    const authPath = await tmpAuth();
    const rejected = fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "401 Unauthorized: invalid x-api-key",
    });
    const { interaction, prompts } = client(["eu", "sk-bad", "eu", "sk-good"]);

    const result = await login({
      provider: "keyed",
      method: "api_key",
      authPath,
      interaction,
      providers: [keyedFaux([rejected, fauxAssistantMessage("pong")], [401, 200])],
    });

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
    const pending = login({
      provider: "keyed",
      method: "api_key",
      authPath,
      interaction,
      providers: [keyedFaux([rejected], [401])],
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(3)); // the region again: the retry has begun

    abort.abort();

    await expect(pending).rejects.toBeInstanceOf(LoginCancelled);
    expect((await readAuth(authPath)).keyed).toEqual(previous);
  });

  it("aborting while the key is being verified rejects with LoginCancelled and writes nothing", async () => {
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
    const pending = login({
      provider: "keyed",
      method: "api_key",
      authPath,
      interaction,
      providers: [keyedFaux([hanging as never])],
    });
    await vi.waitFor(() => expect(events.map((e) => e.type)).toContain("progress")); // "verifying the key…"

    abort.abort();

    await expect(pending).rejects.toBeInstanceOf(LoginCancelled);
    expect((await readAuth(authPath).catch(() => ({}))).keyed).toBeUndefined();
  });

  it("a model that cannot verify this provider's key is refused before anything runs or is written", async () => {
    for (const [model, reason] of [
      ["keyed/no-such-model", /not in registry|unknown|no-such-model/i],
      ["anthropic/claude-sonnet-4-5", /belongs to "anthropic", not "keyed"/],
    ] as const) {
      const authPath = await tmpAuth();
      const { interaction, prompts } = client(["eu", "sk"]);
      await expect(
        login({ provider: "keyed", method: "api_key", authPath, interaction, model, providers: [keyedFaux([])] }),
      ).rejects.toThrow(reason);
      expect(prompts).toHaveLength(0); // the flow never started
      expect((await readAuth(authPath).catch(() => ({}))).keyed).toBeUndefined();
    }
  });

  it("aborting the interaction's signal rejects with LoginCancelled and writes nothing", async () => {
    const authPath = await tmpAuth();
    const abort = new AbortController();
    const { interaction, prompts } = client([], abort.signal); // never answers: waits on the prompt's signal
    const pending = login({ provider: "openai", method: "api_key", authPath, interaction, providers: PROVIDERS });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));

    abort.abort();

    await expect(pending).rejects.toBeInstanceOf(LoginCancelled);
    expect((await readAuth(authPath).catch(() => ({}))).openai).toBeUndefined();
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

    const result = await login({ provider: "codex", method: "oauth", authPath, interaction, providers });

    expect(result).toEqual({ provider: "codex", method: "oauth", verified: "n/a" });
    expect(prompts[0]?.type).toBe("manual_code");
    expect((await readAuth(authPath)).codex.type).toBe("oauth");
  });

  it("loginOptions offers each interactive method, with what the file holds for the provider", async () => {
    const authPath = await tmpAuth(JSON.stringify({ anthropic: { type: "api_key", key: "sk" } }));

    const offered = await loginOptions(authPath, { providers: PROVIDERS });

    // The built-ins are always offered; the test's providers are added (replacing the built-in of the same id).
    expect(offered.some((o) => o.provider === "openai-codex")).toBe(true);
    const ours = new Set(PROVIDERS.map((p) => p.id));
    expect(offered.filter((o) => ours.has(o.provider))).toEqual([
      { provider: "anthropic", method: "oauth", label: "anthropic (OAuth)", subscription: false, stored: "api_key" },
      { provider: "anthropic", method: "api_key", label: "anthropic API key", subscription: false, stored: "api_key" },
      { provider: "openai", method: "api_key", label: "openai API key", subscription: false },
      { provider: "codex", method: "oauth", label: "codex (OAuth)", subscription: false },
    ]);
  });

  it("canVerifyWith: a built-in model, yes; one an agent's models.json added to a built-in provider, no", () => {
    // The first-run picker lists the AGENT's registry; handing login a spec its registry lacks refused the sign-in
    // before the key was even asked for.
    expect(canVerifyWith("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(canVerifyWith("anthropic/claude-only-in-models-json")).toBe(false);
    expect(canVerifyWith("no-slash")).toBe(false);
  });

  it("loginOptions reads the credentials file once: a corrupt file warns once, not once per provider", async () => {
    const authPath = await tmpAuth("{bad");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    await loginOptions(authPath);

    expect(warn.mock.calls.filter(([m]) => /corrupt auth file/.test(String(m)))).toHaveLength(1);
  });

  it("is public from the pi entry point", async () => {
    const pi = await import("../src/pi.ts");
    expect(typeof pi.login).toBe("function");
    expect(typeof pi.loginOptions).toBe("function");
    expect(new pi.LoginCancelled("x")).toBeInstanceOf(Error);
  });
});
