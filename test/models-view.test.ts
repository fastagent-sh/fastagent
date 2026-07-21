import { describe, expect, it } from "vitest";
import { buildModelPickerOptions, formatModelsCommand } from "../src/cli/models-view.ts";
import type { ProviderAuthStatus } from "../src/engines/pi/models.ts";

describe("models-view: formatModelsCommand (`fastagent models [search]` stdout/stderr)", () => {
  it("no search → all lines; a substring filters; a miss → empty lines + an stderr diagnostic", () => {
    const specs = ["openai/gpt-5", "anthropic/claude", "openai/o3"];
    expect(formatModelsCommand(specs)).toEqual({ lines: specs }); // no search → all, no error
    expect(formatModelsCommand(specs, "OpenAI")).toEqual({ lines: ["openai/gpt-5", "openai/o3"] }); // case-insensitive
    expect(formatModelsCommand(specs, "zzznope")).toEqual({ lines: [], error: 'no model matches "zzznope"' }); // miss
  });

  it("buildModelPickerOptions: ready first (annotated with the source), remedy-annotated after, broken visible", () => {
    const statuses = new Map<string, ProviderAuthStatus>([
      ["openai", { state: "ready", source: "OPENAI_API_KEY" }],
      ["oauthy", { state: "ready" }], // no source label → plain "ready"
      ["anthropic", { state: "unconfigured", login: "oauth" }], // OAuth flow → "login required"
      ["keyentry", { state: "unconfigured", login: "api_key" }], // interactive key prompt → "API key required"
      ["envonly", { state: "unconfigured", login: "none" }], // no flow at all → point at the env var
      ["codex", { state: "broken", message: "expired", login: "oauth" }],
      ["deadenv", { state: "broken", message: "corrupt", login: "none" }], // broken + no flow → fix the STORE, not the env
    ]);
    const specs = [
      "anthropic/claude",
      "codex/gpt-5.5",
      "deadenv/m3",
      "envonly/m1",
      "keyentry/m1",
      "oauthy/m1",
      "openai/gpt-5",
      "unknown/m2",
    ];
    expect(buildModelPickerOptions(specs, statuses)).toEqual([
      // ready group leads, input order preserved within each group
      { value: "oauthy/m1", label: "oauthy/m1", hint: "ready" },
      { value: "openai/gpt-5", label: "openai/gpt-5", hint: "ready — OPENAI_API_KEY" },
      { value: "anthropic/claude", label: "anthropic/claude", hint: "login required" },
      { value: "codex/gpt-5.5", label: "codex/gpt-5.5", hint: "login required — stored auth unusable: expired" },
      {
        value: "deadenv/m3",
        label: "deadenv/m3",
        // NOT the env-var wording: a broken stored credential owns the provider (env is only consulted
        // when nothing is stored), so the remedy must point at the store.
        hint: "stored auth unusable: corrupt — fix or remove the stored credential",
      },
      { value: "envonly/m1", label: "envonly/m1", hint: "API key required — set the provider's env var" },
      { value: "keyentry/m1", label: "keyentry/m1", hint: "API key required" },
      { value: "unknown/m2", label: "unknown/m2", hint: "auth required" }, // absent from the map → neutral, no login claim
    ]);
  });

  it("ranks a provider-name match above an incidental model-id match (anthropic/* before bedrock/anthropic.*)", () => {
    const specs = [
      "amazon-bedrock/anthropic.claude-opus", // matches "anthropic" only in the model id
      "anthropic/claude-opus", // matches in the PROVIDER
      "google-vertex/claude-anthropic", // model id only
      "anthropic/claude-sonnet", // provider
    ];
    // Provider matches lead (order within the group preserved); incidental id matches follow.
    expect(formatModelsCommand(specs, "anthropic").lines).toEqual([
      "anthropic/claude-opus",
      "anthropic/claude-sonnet",
      "amazon-bedrock/anthropic.claude-opus",
      "google-vertex/claude-anthropic",
    ]);
  });
});
