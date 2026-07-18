import { describe, expect, it } from "vitest";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { probeApiKey, providerAuthStatuses } from "../src/engines/pi/models.ts";

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
