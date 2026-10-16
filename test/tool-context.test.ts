import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import { collect } from "../src/protocol-collect.ts";
import { defineTool } from "../src/harnesses/pi/tool.ts";
import { fauxAgent } from "./agent.ts";

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
    const { agent } = fauxAgent(
      [fauxAssistantMessage(fauxToolCall("probe", {}, { id: "c1" })), fauxAssistantMessage("done")],
      { tools: [probe] },
    );

    const { text } = await collect(agent.invoke({ sessionId: "sess-42", prompt: { text: "go" } }));

    expect(text).toBe("done");
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
