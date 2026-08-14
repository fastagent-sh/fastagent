import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { createPiModelRuntime, probeApiKey, probeAuthSource, providerAuthStatuses } from "../src/engines/pi/models.ts";
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
    const runtime = await createPiModelRuntime({ agentDir: dir, authPath: join(dir, "auth.json") });

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
      expect(await probeAuthSource(runtime, "mygw/deepseek-v3")).toBeDefined();
    } finally {
      delete process.env.FASTAGENT_TEST_GW_KEY;
    }
  });

  it("a malformed models.json fails visibly instead of degrading to the built-ins", async () => {
    // Upstream `ModelRuntime.create` RESOLVES on a parse error and parks the reason in getError(),
    // so an unread error would surface later as a bare "unknown model" — the silent fallback this
    // codebase forbids. The throw must name the file so the typo is findable.
    const dir = await agentWith("{ not json");
    await expect(createPiModelRuntime({ agentDir: dir, authPath: join(dir, "auth.json") })).rejects.toThrow(
      /models\.json/,
    );
  });

  it("no models.json is the normal case: built-ins load, nothing throws", async () => {
    const dir = await agentWith(undefined);
    const runtime = await createPiModelRuntime({ agentDir: dir, authPath: join(dir, "auth.json") });
    expect(runtime.getProvider("anthropic")).toBeDefined();
  });

  it("pi's generated catalog cache lands in the state root, never in the agent dir", async () => {
    // pi defaults modelsStorePath to `<dirname(modelsPath)>/models-store.json` — i.e. inside the agent
    // dir, which `deploy` bakes wholesale into the image. The definition dir holds authored files only.
    const dir = await agentWith(GATEWAY);
    const stateRoot = join(dir, ".state");
    await mkdir(stateRoot, { recursive: true });
    await createPiModelRuntime({ agentDir: dir, authPath: join(dir, "auth.json"), stateRoot });
    expect(existsSync(join(dir, "models-store.json"))).toBe(false);
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
