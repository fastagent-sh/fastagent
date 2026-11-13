import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { SignInCancelled } from "../../../src/sign-in-api.ts";
import {
  type IoOption,
  type LoginIO,
  LoginRefused,
  chooseLogin,
  loginFlow,
  loginOptionsOver,
  loginOver,
} from "../../../src/harnesses/models/login.ts";

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
});
