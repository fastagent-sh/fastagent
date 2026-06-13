/**
 * Run the SPEC conformance suite (spec-conformance.ts) against the pi reference
 * implementation — the full L0 composition (lease + fan-in + translators) over a
 * faux model. Engine #2 gets conformance for free by providing its own subject.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, registerFauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { inMemorySessionStore, jsonlSessionStore, type SessionStore } from "../src/index.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { describeSpecConformance } from "./spec-conformance.ts";

function piAgent(responses: FauxResponseStep[], sessions: SessionStore = inMemorySessionStore()) {
  const faux = registerFauxProvider();
  faux.setResponses(responses);
  return createPiAgentFromHarness({
    harnessFactory: piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      model: faux.getModel(),
      systemPrompt: "test",
    }),
  });
}

describeSpecConformance("pi reference implementation (faux model, full L0 composition)", {
  completing: () => piAgent([fauxAssistantMessage("hello world")]),

  failing: () => piAgent([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "boom 500" })]),

  hanging: (onCleanup) => {
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("a long answer that streams out slowly")]);
    const inner = piHarnessFactory({
      sessions: inMemorySessionStore(),
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      model: faux.getModel(),
      systemPrompt: "test",
    });
    // The engine's cancel cleanup is harness.abort() — intercept it as the probe.
    return createPiAgentFromHarness({
      harnessFactory: async (sessionId) => {
        const harness = await inner(sessionId);
        const abort = harness.abort.bind(harness);
        harness.abort = async () => {
          onCleanup();
          return abort();
        };
        return harness;
      },
    });
  },

  // Portable conformance: two agent instances, two SEPARATE jsonl stores over the
  // same directory — nothing shared in-process, the disk is the only common state
  // (the serverless/AgentCore shape in miniature).
  pair: async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-conformance-"));
    let saw = false;
    const a = piAgent([fauxAssistantMessage("the code is 47")], jsonlSessionStore({ dir }));
    const b = piAgent(
      [
        (context) => {
          saw = JSON.stringify(context.messages).includes("the code is 47");
          return fauxAssistantMessage("ok");
        },
      ],
      jsonlSessionStore({ dir }),
    );
    return { a, b, sawHistory: () => saw };
  },
});
