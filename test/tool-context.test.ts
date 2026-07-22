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

/** Call a built tool's execute directly (the `fastagent tool` path — no session binding). */
type RawExecute = (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;

describe("shared ToolContext session manager", () => {
  it("a defineTool tool reads the CURRENT turn's manager through the shared runtime context", async () => {
    // A tool is built once and reused across sessions, so its manager cannot be a definition closure.
    // If turn-context propagation through pi's tool execution breaks, `seen` stays unset.
    let seen: string | undefined = "UNSET";
    const probe = defineTool({
      name: "probe",
      description: "records the session it ran in",
      input: z.object({}),
      execute(_input, ctx) {
        seen = ctx.sessionManager?.getSessionId();
        return "ok";
      },
    });
    const { faux, models } = makeFaux();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("probe", {}, { id: "c1" })), fauxAssistantMessage("done")]);
    const agent = createPiAgentFromHarness({
      cwd: process.cwd(),
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
    for await (const event of agent.invoke({ session: "sess-42" }, { text: "go" })) events.push(event);

    expect(events.at(-1)?.type).toBe("completed");
    expect(seen).toBe("sess-42");
  });

  it("sessionManager is undefined outside an agent turn", async () => {
    let seen = true;
    const probe = defineTool({
      description: "records session availability",
      input: z.object({}),
      execute(_input, ctx) {
        seen = ctx.sessionManager !== undefined;
        return "ok";
      },
    });
    await (probe as unknown as { execute: RawExecute }).execute("cli", {});
    expect(seen).toBe(false);
  });
});
