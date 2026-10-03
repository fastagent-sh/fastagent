/**
 * A Sign in with ChatGPT on `openai` lists the account's own catalog (`GET /v1/models`), kept on the credential and
 * read again on every token refresh; an API key keeps pi's built-in list.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Models, OAuthCredential, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { availableModelsFromDir } from "../src/engines/pi/open.ts";
import { agentModels } from "../src/engines/pi/agent-models.ts";
import { fastagentCredentialStore } from "../src/engines/pi/auth.ts";
import { machineModelRuntime, piModelsOver } from "../src/engines/pi/models.ts";
import { withAccountModels } from "../src/engines/pi/openai-account-models.ts";

const MODELS_URL = "https://api.openai.com/v1/models";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";

/** OpenAI's catalog answer: two models to list, one hidden. */
const CATALOG = {
  models: [
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
    { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" },
  ],
};

function oauth(extra: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: "at-old",
    refresh: "rt-old",
    expires: Date.now() + 3_600_000,
    clientId: "c",
    ...extra,
  };
}

async function workspace(credentials: Record<string, unknown>): Promise<{ dir: string; authPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fa-openai-account-"));
  await mkdir(join(dir, "agent"));
  await writeFile(join(dir, "agent", "fastagent.config.ts"), "export default {};");
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify(credentials));
  return { dir, authPath };
}

const openaiSpecs = async (dir: string, authPath: string, warn?: (message: string) => void) =>
  (await availableModelsFromDir(dir, { authPath, ...(warn ? { warn } : {}) }))
    .map((model) => model.spec)
    .filter((spec) => spec.startsWith("openai/"));

/** Answer the token and catalog endpoints; `catalog` is the catalog's status (200 serves {@link CATALOG}). */
function stubOpenAI(catalog = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === TOKEN_URL) {
      return Response.json({
        access_token: "at-new",
        refresh_token: "rt-new",
        scope: "openid offline_access chatgpt.tokens.use.direct",
        expires_in: 3600,
      });
    }
    if (url === MODELS_URL) {
      return catalog === 200 ? Response.json(CATALOG) : new Response("unavailable", { status: catalog });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("what a ChatGPT sign-in lists", () => {
  it("lists the account's catalog, and an API key keeps pi's built-in list", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const signedIn = await workspace({ openai: oauth({ accountModels: ["gpt-5.5", "gpt-6-astra"] }) });
    expect(await openaiSpecs(signedIn.dir, signedIn.authPath)).toEqual(["openai/gpt-5.5", "openai/gpt-6-astra"]);

    const keyed = await workspace({ openai: { type: "api_key", key: "sk-test" } });
    expect((await openaiSpecs(keyed.dir, keyed.authPath)).length).toBeGreaterThan(2);
  });

  it("a sign-in with no catalog lists nothing for openai and logs why, without failing a throwing warn", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const { dir, authPath } = await workspace({ openai: oauth() });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // The documented sink for a broken credentials file: it must not hear this normal, recoverable state.
    const specs = (
      await availableModelsFromDir(dir, {
        authPath,
        warn: (message) => {
          throw new Error(`credentials: ${message}`);
        },
      })
    ).map((model) => model.spec);
    expect(specs.filter((spec) => spec.startsWith("openai/"))).toEqual([]);
    expect(specs.some((spec) => spec.startsWith("anthropic/"))).toBe(true);
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/carries no model catalog.*fastagent login/));
  });

  it("a token refresh, through any registry that can make one, reads the catalog again and stores it", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const fetch = stubOpenAI();
    // The agent's runtime (turns, the agent catalog refresh), the machine's (`models --refresh -g`), and the bare
    // registry login is built on: a registry that refreshed without the wrapper would drop the catalog.
    const registries: Record<string, (dir: string, authPath: string) => Promise<Models>> = {
      agent: (dir, authPath) => agentModels(join(dir, "agent"), { authPath }).runtime(),
      machine: (_dir, authPath) => machineModelRuntime({ credentials: fastagentCredentialStore(authPath) }),
      bare: async (_dir, authPath) => piModelsOver(fastagentCredentialStore(authPath)),
    };
    for (const [name, open] of Object.entries(registries)) {
      fetch.mockClear();
      const { dir, authPath } = await workspace({ openai: oauth({ expires: 1, accountModels: ["gpt-5.5"] }) });
      const models = await open(dir, authPath);
      expect((await models.getAuth("openai"))?.auth.apiKey, name).toBe("at-new");
      const stored = JSON.parse(await readFile(authPath, "utf8")).openai;
      expect(stored, name).toMatchObject({ refresh: "rt-new", accountModels: ["gpt-5.5", "gpt-6-astra"] });
      // Registered more than once (the agent's runtime again after its extensions load), wrapped once.
      const reads = fetch.mock.calls.filter(([input]) => String(input) === MODELS_URL);
      expect(reads, name).toHaveLength(1);
    }
  });

  it("a refresh whose catalog read fails still stores the rotated token, with the previous catalog", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const { dir, authPath } = await workspace({ openai: oauth({ expires: 1, accountModels: ["gpt-5.5"] }) });
    stubOpenAI(503);
    const models = await agentModels(join(dir, "agent"), { authPath }).runtime();
    expect((await models.getAuth("openai"))?.auth.apiKey).toBe("at-new");

    // The old refresh token is spent: losing the new one would sign the account out.
    const stored = JSON.parse(await readFile(authPath, "utf8")).openai;
    expect(stored).toMatchObject({ refresh: "rt-new", accountModels: ["gpt-5.5"] });
  });

  it("an extension that re-registers openai keeps the catalog: listed, and carried over a refresh", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const { dir, authPath } = await workspace({ openai: oauth({ expires: 1, accountModels: ["gpt-5.5"] }) });
    await mkdir(join(dir, "agent", "extensions"));
    await writeFile(
      join(dir, "agent", "extensions", "gateway.ts"),
      `export default (pi) => { pi.registerProvider("openai", { headers: { "x-gateway": "1" } }); };`,
    );
    const fetch = stubOpenAI();
    const models = await agentModels(join(dir, "agent"), { authPath }).runtime();
    expect((await models.getAuth("openai"))?.auth.apiKey).toBe("at-new");
    const stored = JSON.parse(await readFile(authPath, "utf8")).openai;
    expect(stored).toMatchObject({ refresh: "rt-new", accountModels: ["gpt-5.5", "gpt-6-astra"] });
    // Wrapped once, however often it was registered: one catalog read per refresh.
    expect(fetch.mock.calls.filter(([input]) => String(input) === MODELS_URL)).toHaveLength(1);
    expect((await models.getAvailable("openai")).map((m) => m.id).sort()).toEqual(["gpt-5.5", "gpt-6-astra"]);
  });

  it("the agent's models.json overrides on openai still apply over the wrapped provider", async () => {
    const { dir, authPath } = await workspace({ openai: oauth({ accountModels: ["gpt-5.5"] }) });
    await writeFile(
      join(dir, "agent", "models.json"),
      JSON.stringify({
        providers: { openai: { modelOverrides: { "gpt-5.5": { name: "Renamed", contextWindow: 1000 } } } },
      }),
    );
    const listed = (await availableModelsFromDir(dir, { authPath })).filter((m) => m.spec.startsWith("openai/"));
    expect(listed).toEqual([expect.objectContaining({ spec: "openai/gpt-5.5", name: "Renamed", contextWindow: 1000 })]);
  });
});

describe("login reads the catalog", () => {
  const base = (credential: OAuthCredential): Provider =>
    ({
      id: "openai",
      auth: {
        oauth: { name: "x", login: async () => credential, refresh: async () => credential, toAuth: async () => ({}) },
      },
    }) as unknown as Provider;
  const interaction = (): ProviderAuthInteraction & { notes: string[] } => {
    const notes: string[] = [];
    return {
      notes,
      signal: new AbortController().signal,
      prompt: async () => "",
      notify: (event) => notes.push("message" in event ? event.message : event.type),
    } as ProviderAuthInteraction & { notes: string[] };
  };

  it("a sign-in carries the account's listed models", async () => {
    stubOpenAI();
    const io = interaction();
    const credential = await withAccountModels(base(oauth())).auth.oauth?.login(io);
    expect(credential?.accountModels).toEqual(["gpt-5.5", "gpt-6-astra"]);
  });

  it("a catalog that cannot be read keeps the sign-in and says the list is empty", async () => {
    stubOpenAI(401);
    const io = interaction();
    const credential = await withAccountModels(base(oauth())).auth.oauth?.login(io);
    expect(credential?.access).toBe("at-old");
    expect(credential?.accountModels).toBeUndefined();
    expect(io.notes).toEqual([expect.stringMatching(/could not read this ChatGPT account's model catalog.*401/)]);
  });
});
