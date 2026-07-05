import { describe, expect, it, vi } from "vitest";
import type { Models } from "@earendil-works/pi-ai";
import { log } from "../src/log.ts";
import { configuredModelSpecs } from "../src/engines/pi/models.ts";

type FakeProvider = { id: string; models: string[]; auth: "ok" | "none" | "reject" };

/** A minimal Models stub exposing only what configuredModelSpecs touches: getProviders + getAuth. */
function fakeModels(providers: FakeProvider[]): Models {
  return {
    getProviders: () =>
      providers.map((p) => ({
        id: p.id,
        getModels: () => p.models.map((id) => ({ id, provider: p.id })),
      })),
    getAuth: async (model: { provider: string }) => {
      const p = providers.find((x) => x.id === model.provider);
      if (!p || p.auth === "reject") throw new Error("expired");
      return p.auth === "ok" ? { source: "test" } : undefined;
    },
  } as unknown as Models;
}

describe("configuredModelSpecs", () => {
  it("lists only models of providers with usable auth, sorted", async () => {
    const models = fakeModels([
      { id: "anthropic", models: ["claude-b", "claude-a"], auth: "ok" },
      { id: "openai", models: ["gpt-x"], auth: "none" }, // unconfigured → omitted
    ]);
    expect(await configuredModelSpecs(models)).toEqual(["anthropic/claude-a", "anthropic/claude-b"]);
  });

  it("omits a provider whose auth rejects (configured-but-expired) and warns — not a silent drop", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const models = fakeModels([
      { id: "openai", models: ["gpt-x"], auth: "reject" }, // expired → not offered, but visible
      { id: "empty", models: [], auth: "ok" }, // no models → skipped
      { id: "codex", models: ["gpt-5.5"], auth: "ok" },
    ]);
    expect(await configuredModelSpecs(models)).toEqual(["codex/gpt-5.5"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider "openai": auth check failed'));
    warn.mockRestore();
  });

  it("returns empty when nothing is configured", async () => {
    expect(await configuredModelSpecs(fakeModels([{ id: "openai", models: ["gpt-x"], auth: "none" }]))).toEqual([]);
  });
});
