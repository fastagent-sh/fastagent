import { describe, expect, it } from "vitest";
import { formatModelsCommand } from "../src/cli-models.ts";

describe("cli-models: formatModelsCommand (`fastagent models [search]` stdout/stderr)", () => {
  it("no search → all lines; a substring filters; a miss → empty lines + an stderr diagnostic", () => {
    const specs = ["openai/gpt-5", "anthropic/claude", "openai/o3"];
    expect(formatModelsCommand(specs)).toEqual({ lines: specs }); // no search → all, no error
    expect(formatModelsCommand(specs, "OpenAI")).toEqual({ lines: ["openai/gpt-5", "openai/o3"] }); // case-insensitive
    expect(formatModelsCommand(specs, "zzznope")).toEqual({ lines: [], error: 'no model matches "zzznope"' }); // miss
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
