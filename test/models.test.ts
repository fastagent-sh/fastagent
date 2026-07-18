import { describe, expect, it } from "vitest";
import type { Models } from "@earendil-works/pi-ai";
import { providerAuthStatuses } from "../src/engines/pi/models.ts";

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
