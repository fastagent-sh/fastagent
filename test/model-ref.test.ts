import { expect, it } from "vitest";
import { modelRefOf } from "../src/model-ref.ts";

it("splits a model selection at its first slash", () => {
  expect(modelRefOf("provider/model", "--model")).toEqual({ provider: "provider", modelId: "model" });
  expect(modelRefOf("openrouter/owner/model", "the default model")).toEqual({
    provider: "openrouter",
    modelId: "owner/model",
  });
});

it.each(["", "model", "/model", "provider/"])("refuses %j with the caller's context", (spec) => {
  expect(() => modelRefOf(spec, "--model")).toThrow(`--model must be "provider/modelId", got ${JSON.stringify(spec)}`);
});
