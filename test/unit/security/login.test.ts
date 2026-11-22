import { existsSync } from "node:fs";
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
import { createServer } from "node:net";
import { connectAgent, connectAuth } from "../../../packages/client/src/http/client.ts";
import { activeWork } from "../../../packages/fastagent/src/busy.ts";
import { listenLocalRedirect } from "../../../packages/fastagent/src/cli/remote-login.ts";
import { modelEnvironment } from "../../../packages/fastagent/src/harnesses/models/environment.ts";
import { createAuthManager } from "../../../packages/fastagent/src/harnesses/models/remote-auth.ts";
import { overlayCredentialStore } from "../../../packages/fastagent/src/harnesses/models/credentials.ts";
import {
  memoryDurableCredentialStore,
  postgresDurableCredentialStore,
  sqliteDurableCredentialStore,
} from "../../../packages/fastagent/src/harnesses/models/durable-credentials.ts";
import { scriptedAgent } from "../../doubles/scripted-agent.ts";
import { KEY, served } from "../../harnesses/http-subject.ts";
import { openSource } from "../../harnesses/open-source.ts";
import { type IoOption, type LoginIO, chooseLogin, loginFlow } from "../../../packages/fastagent/src/cli/login-ui.ts";
import {
  LoginRefused,
  SignInCancelled,
  loginOptionsOver,
  loginOver,
} from "../../../packages/fastagent/src/harnesses/models/login.ts";

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

describe("durable instance credentials and remote Auth HTTP API", () => {
  it("persists OAuth credentials and deviceId in instance storage across reopen and layers over fallback store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-durable-creds-"));
    const dbPath = join(dir, "credentials.sqlite");
    const store1 = sqliteDurableCredentialStore(dbPath);
    const deviceId1 = await store1.getOrCreateDeviceId();
    await store1.modify("openai-codex", async () => ({
      type: "oauth",
      access: "acc-1",
      refresh: "ref-1",
      expires: Date.now() + 3_600_000,
    }));
    await store1.close();

    const store2 = sqliteDurableCredentialStore(dbPath);
    try {
      expect(await store2.getOrCreateDeviceId()).toBe(deviceId1);
      expect(await store2.read("openai-codex")).toMatchObject({ type: "oauth", access: "acc-1", refresh: "ref-1" });
      expect(await store2.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);

      const fallbackCreds = new Map<string, Credential>([
        ["anthropic", { type: "api_key", key: "fallback-key" }],
        ["openai-codex", { type: "oauth", access: "stale", refresh: "stale", expires: 0 }],
      ]);
      const overlay = overlayCredentialStore(() => store2, {
        read: async (id) => fallbackCreds.get(id),
        list: async () => [...fallbackCreds.entries()].map(([providerId, c]) => ({ providerId, type: c.type })),
        modify: async (id, fn) => {
          const next = await fn(fallbackCreds.get(id));
          if (next !== undefined) fallbackCreds.set(id, next);
          return next;
        },
        delete: async (id) => {
          fallbackCreds.delete(id);
        },
      });
      // Durable primary outranks fallback for openai-codex, while fallback still serves anthropic.
      expect(await overlay.read("openai-codex")).toMatchObject({ access: "acc-1" });
      expect(await overlay.read("anthropic")).toEqual({ type: "api_key", key: "fallback-key" });
      await overlay.delete("openai-codex");
      expect(await store2.read("openai-codex")).toBeUndefined();
      // DELETE journal mode leaves no persistent -wal sidecar file holding plaintext tokens.
      expect(existsSync(`${dbPath}-wal`)).toBe(false);

      const brokenPg = postgresDurableCredentialStore({ url: "postgres://127.0.0.1:1/unreachable" }, "inst-1");
      await expect(brokenPg.read("openai-codex")).rejects.toMatchObject({ code: "unavailable", retryable: true });
      await brokenPg.close();
    } finally {
      await store2.close();
    }
  });

  it("drives OAuth auth_url + manual_code, device_code polling, cancel, and logout over HTTP via connectAuth", async () => {
    const durableStore = memoryDurableCredentialStore();

    let finishDevice!: () => void;
    const deviceReady = new Promise<void>((resolve) => {
      finishDevice = resolve;
    });
    const oauthProvider: Provider = {
      ...fauxProvider({ provider: "remote-oauth", models: [{ id: "m1" }] }).provider,
      name: "Remote OAuth",
      auth: {
        oauth: {
          name: "Sign in with Remote OAuth",
          login: async (interaction: AuthInteraction, opts?: { getDeviceId?: () => string }): Promise<Credential> => {
            const devId = opts?.getDeviceId?.() ?? "none";
            interaction.notify({
              type: "auth_url",
              url: "https://auth.example.com/authorize?redirect_uri=http://localhost:1455/cb",
              instructions: "Paste the redirect URL",
            });
            const pasted = await interaction.prompt({ type: "manual_code", message: "Paste callback URL" });
            return {
              type: "oauth",
              access: `tok-${pasted}-${devId}`,
              refresh: "ref-remote",
              expires: Date.now() + 3_600_000,
            };
          },
          refresh: async (credential: Credential) => credential,
          toAuth: (credential: { access: string }) => ({ apiKey: credential.access }),
        },
      },
    } as unknown as Provider;

    const deviceProvider: Provider = {
      ...fauxProvider({ provider: "device-oauth", models: [{ id: "m1" }] }).provider,
      name: "Device OAuth",
      auth: {
        oauth: {
          name: "Device Sign-in",
          login: async (interaction: AuthInteraction): Promise<Credential> => {
            interaction.notify({
              type: "device_code",
              userCode: "ABCD-1234",
              verificationUri: "https://device.example.com/activate",
            });
            await deviceReady;
            return { type: "oauth", access: "dev-tok", refresh: "dev-ref", expires: Date.now() + 3_600_000 };
          },
          refresh: async (credential: Credential) => credential,
          toAuth: (credential: { access: string }) => ({ apiKey: credential.access }),
        },
      },
    } as unknown as Provider;

    const customProviders = [oauthProvider, deviceProvider];
    const models = await modelEnvironment(undefined, { authPath: null }, customProviders, {
      credentialStore: () => durableStore,
    });
    const authManager = createAuthManager({ models, durableStore, providers: customProviders });
    const http = await served(
      scriptedAgent(() => []),
      { auth: authManager },
    );
    try {
      const client = connectAuth(http.url, { apiKey: KEY });
      const initial = await client.providers();
      expect(initial.find((p) => p.provider === "remote-oauth")).toMatchObject({
        authenticated: false,
        methods: ["oauth"],
      });

      // 1. OAuth auth_url + manual_code flow
      const started = await client.startLogin({ provider: "remote-oauth", method: "oauth" });
      expect(started.status).toBe("awaiting_input");
      expect(started.authUrl?.url).toContain("https://auth.example.com/authorize");
      expect(started.prompt?.type).toBe("manual_code");

      // Wrong promptId is refused cleanly.
      await expect(client.submitInput(started.flowId, { promptId: "wrong-id", value: "code-1" })).rejects.toMatchObject(
        { code: "invalid_request" },
      );

      const done = await client.submitInput(started.flowId, { promptId: started.prompt!.id, value: "code-42" });
      expect(done.status).toBe("completed");
      const stored = await durableStore.read("remote-oauth");
      expect(stored?.type).toBe("oauth");
      expect((stored as { access: string }).access).toMatch(/^tok-code-42-/);

      const afterLogin = await client.providers();
      expect(afterLogin.find((p) => p.provider === "remote-oauth")).toMatchObject({
        authenticated: true,
        stored: "oauth",
        source: "OAuth",
      });

      // 2. Device code polling flow
      const devStarted = await client.startLogin({ provider: "device-oauth" });
      expect(devStarted.deviceCode).toMatchObject({
        userCode: "ABCD-1234",
        verificationUri: "https://device.example.com/activate",
      });
      const polled = client.getLogin(devStarted.flowId, { wait: 10 });
      finishDevice();
      expect((await polled).status).toBe("completed");

      // 3. Cancel an in-flight flow
      const toCancel = await client.startLogin({ provider: "remote-oauth", method: "oauth" });
      expect(toCancel.status).toBe("awaiting_input");
      await client.cancelLogin(toCancel.flowId);
      expect((await client.getLogin(toCancel.flowId)).status).toBe("canceled");

      // 4. Remote logout removes durable credential
      expect(await client.logout("remote-oauth")).toEqual({ removed: true });
      expect(await client.logout("remote-oauth")).toEqual({ removed: false });
      expect(await durableStore.read("remote-oauth")).toBeUndefined();
    } finally {
      authManager.close();
      await http.close();
      await durableStore.close();
    }
  });

  it("lets a served agent answer turns using a credential logged in via connectAuth and survives restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-remote-auth-turn-"));
    await writeFile(
      join(dir, "fastagent.config.ts"),
      `import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
const faux = fauxProvider({ provider: "remote-keyed", models: [{ id: "m1" }] });
faux.setResponses([fauxAssistantMessage("verify-ok"), fauxAssistantMessage("first-ok"), fauxAssistantMessage("second-ok")]);
const provider = {
  ...faux.provider,
  name: "Remote Keyed",
  auth: {
    apiKey: {
      name: "Remote Keyed API key",
      login: async (interaction) => {
        const key = await interaction.prompt({ type: "secret", message: "API key" });
        return { type: "api_key", key };
      },
      resolve: async ({ credential }) =>
        credential?.type === "api_key" && credential.key === "sk-live"
          ? { auth: { apiKey: credential.key }, source: "stored credential" }
          : undefined,
    },
  },
};
export default { model: "remote-keyed/m1", providers: [provider] };
`,
    );

    const first = await openSource(dir, { secrets: {} });
    const svc1 = await first.serve({ apiKeys: [KEY] });
    const port1 = await svc1.listen(0, "127.0.0.1");
    try {
      const auth = connectAuth(`http://127.0.0.1:${port1}`, { apiKey: KEY });
      const started = await auth.startLogin({ provider: "remote-keyed", method: "api_key" });
      expect(started.status).toBe("awaiting_input");
      const completed = await auth.submitInput(started.flowId, { promptId: started.prompt!.id, value: "sk-live" });
      expect(completed.status).toBe("completed");
      expect(completed.verified).toBe("ok");

      const agentClient = connectAgent(`http://127.0.0.1:${port1}`, { apiKey: KEY });
      const session = await agentClient.sessions.create();
      const msg = await agentClient.messages.send({ sessionId: session.id, content: "hi" }, { wait: 15 });
      expect(msg.status).toBe("completed");
    } finally {
      await first.close();
    }

    // Reopen on the same root on BOTH harnesses: credential persists in shared instance storage across harness switches.
    const dshView = await openSource(dir, { secrets: {}, harness: "dsh", sandbox: "off" });
    const dshSvc = await dshView.serve({ apiKeys: [KEY] });
    const dshPort = await dshSvc.listen(0, "127.0.0.1");
    try {
      const dshAuth = connectAuth(`http://127.0.0.1:${dshPort}`, { apiKey: KEY });
      expect((await dshAuth.providers()).find((p) => p.provider === "remote-keyed")).toMatchObject({
        authenticated: true,
        stored: "api_key",
      });
    } finally {
      await dshView.close();
    }

    const second = await openSource(dir, { secrets: {} });
    const svc2 = await second.serve({ apiKeys: [KEY] });
    const port2 = await svc2.listen(0, "127.0.0.1");
    try {
      const auth2 = connectAuth(`http://127.0.0.1:${port2}`, { apiKey: KEY });
      expect((await auth2.providers()).find((p) => p.provider === "remote-keyed")).toMatchObject({
        authenticated: true,
        stored: "api_key",
      });
      const agentClient2 = connectAgent(`http://127.0.0.1:${port2}`, { apiKey: KEY });
      const session2 = await agentClient2.sessions.create();
      const msg2 = await agentClient2.messages.send({ sessionId: session2.id, content: "again" }, { wait: 15 });
      expect(msg2.status).toBe("completed");
    } finally {
      await second.close();
    }
  });

  it("tracks active login flows in busy() and auto-cancels them on TTL expiry, and listenLocalRedirect enforces OAuth state", async () => {
    const durableStore = memoryDurableCredentialStore();
    const slowProvider: Provider = {
      ...fauxProvider({ provider: "slow-oauth", models: [{ id: "m1" }] }).provider,
      name: "Slow OAuth",
      auth: {
        oauth: {
          name: "Slow OAuth",
          login: async (interaction: AuthInteraction): Promise<Credential> => {
            await interaction.prompt({ type: "manual_code", message: "Paste code" });
            return { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
          },
          refresh: async (credential: Credential) => credential,
          toAuth: (credential: { access: string }) => ({ apiKey: credential.access }),
        },
      },
    } as unknown as Provider;
    const models = await modelEnvironment(undefined, { authPath: null }, [slowProvider], {
      credentialStore: () => durableStore,
    });
    const manager = createAuthManager({ models, durableStore, providers: [slowProvider], activeFlowTtlMs: 80 });
    const baseline = activeWork();
    try {
      const started = await manager.startLogin({ provider: "slow-oauth", method: "oauth" });
      expect(started.status).toBe("awaiting_input");
      expect(activeWork()).toBeGreaterThan(baseline);

      await vi.waitFor(async () => {
        expect((await manager.getLogin(started.flowId)).status).toBe("canceled");
      });
      expect(activeWork()).toBe(baseline);
    } finally {
      manager.close();
      await durableStore.close();
    }

    // Reserve a free ephemeral port, close it, then verify listenLocalRedirect enforces GET + matching state.
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        const bound = typeof addr === "object" && addr ? addr.port : 0;
        probe.close(() => resolve(bound));
      });
    });
    const abort = new AbortController();
    const authUrl = `https://auth.example.com/authorize?state=expected-123&redirect_uri=${encodeURIComponent(`http://localhost:${port}/cb`)}`;
    const captured = listenLocalRedirect(authUrl, abort.signal);
    await new Promise((r) => setTimeout(r, 25));
    try {
      const postRes = await fetch(`http://127.0.0.1:${port}/cb?state=expected-123&code=ok`, { method: "POST" });
      expect(postRes.status).toBe(405);

      const wrongState = await fetch(`http://127.0.0.1:${port}/cb?state=wrong&code=ok`);
      expect(wrongState.status).toBe(400);

      const good = await fetch(`http://127.0.0.1:${port}/cb?state=expected-123&code=ok`);
      expect(good.status).toBe(200);
      expect(await captured).toBe(`http://localhost:${port}/cb?state=expected-123&code=ok`);
    } finally {
      abort.abort();
    }
  });
});
