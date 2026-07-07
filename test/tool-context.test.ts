import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentEvent } from "../src/agent.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { defineTool } from "../src/engines/pi/tool.ts";
import { inMemorySessionStore } from "../src/index.ts";
import { makeFaux } from "./faux.ts";

/** Call a built tool's execute directly (the `fastagent tool` path — no turn, no ALS). */
type RawExecute = (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;

describe("tool ctx.session (turn context via AsyncLocalStorage)", () => {
  it("a tool's execute reads the CURRENT turn's session (ALS propagates through pi's tool call)", async () => {
    // The load-bearing feasibility check for self-scheduling: a defineTool tool is built once and reused
    // across sessions, so it can't close over the session — it must read the turn's session at call time.
    // If ALS did not propagate through pi's tool execution, `seen` would stay unset and this fails.
    let seen: string | undefined = "UNSET";
    const probe = defineTool({
      name: "probe",
      description: "records the session it ran in",
      input: z.object({}),
      execute(_input, ctx) {
        seen = ctx.session;
        return "ok";
      },
    });
    const { faux, models } = makeFaux();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("probe", {}, { id: "c1" })), fauxAssistantMessage("done")]);
    const agent = createPiAgentFromHarness({
      harnessFactory: piHarnessFactory({
        sessions: inMemorySessionStore(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        models,
        model: faux.getModel(),
        tools: [probe],
        systemPrompt: "test",
      }),
    });

    const events: AgentEvent[] = [];
    for await (const e of agent.invoke({ session: "sess-42" }, { text: "go" })) events.push(e);

    expect(events.at(-1)?.type).toBe("completed");
    expect(seen).toBe("sess-42"); // the tool saw the turn's session
  });

  it("ctx.session is undefined outside a turn (a bare `fastagent tool` run, no ALS)", async () => {
    let seen: string | undefined = "UNSET";
    const probe = defineTool({
      description: "records session",
      input: z.object({}),
      execute(_i, ctx) {
        seen = ctx.session;
        return "ok";
      },
    });
    await (probe as unknown as { execute: RawExecute }).execute("cli", {});
    expect(seen).toBeUndefined();
  });
});
