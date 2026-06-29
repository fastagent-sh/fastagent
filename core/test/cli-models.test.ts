import { describe, expect, it } from "vitest";
import { formatModelsCommand } from "../src/cli-models.ts";

describe("cli-models: formatModelsCommand (`fastagent models [search]` stdout/stderr)", () => {
  it("no search → all lines; a substring filters; a miss → empty lines + an stderr diagnostic", () => {
    const specs = ["openai/gpt-5", "anthropic/claude", "openai/o3"];
    expect(formatModelsCommand(specs)).toEqual({ lines: specs }); // no search → all, no error
    expect(formatModelsCommand(specs, "OpenAI")).toEqual({ lines: ["openai/gpt-5", "openai/o3"] }); // case-insensitive
    expect(formatModelsCommand(specs, "zzznope")).toEqual({ lines: [], error: 'no model matches "zzznope"' }); // miss
  });
});
