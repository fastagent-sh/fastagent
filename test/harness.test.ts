import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { inMemorySessionStore } from "../src/index.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { makeFaux } from "./faux.ts";

describe("piHarnessFactory: provider retry wiring", () => {
  it("built harnesses carry maxRetries — the wiring retry-capable pi-ai adapters honor", async () => {
    // Retry-capable adapters (OpenAI-family / Anthropic / Azure / Codex) default to 0 retries —
    // this wiring enables their client-side retries (a transient `fetch failed` killed a whole
    // turn live in the 0.8.0 release verification). google / vertex / bedrock / mistral ignore
    // the option; transients there still fail the turn.
    const { faux, models } = makeFaux();
    const factory = piHarnessFactory({
      sessions: inMemorySessionStore(),
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      systemPrompt: "test",
    });
    const harness = await factory("s1");
    expect(harness.getStreamOptions().maxRetries).toBe(2);
  });
});
