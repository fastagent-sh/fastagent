/**
 * The AgentSession L0's own turn-boundary discipline. The conformance suite drives a real engine;
 * this drives a stub, because the case that matters — a run that settles without producing anything —
 * is exactly what a healthy engine never does.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { createPiAgentFromSession } from "../src/engines/pi/invoke-session.ts";

/** A session carrying one COMPLETED turn of history whose next `prompt()` produces nothing. */
function silentSessionAfterHistory(): AgentSession {
  const messages = [
    { role: "user", content: "turn one", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "the code is 47" }], stopReason: "stop", timestamp: 2 },
  ];
  return {
    state: { messages },
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession;
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("AgentSession L0: the terminal describes THIS turn", () => {
  it("a run that produces no assistant message fails, even when the session holds a completed one", async () => {
    const agent = createPiAgentFromSession({ sessionFactory: async () => silentSessionAfterHistory() });
    const events = await drain(agent.invoke({ session: "durable" }, { text: "turn two" }));
    // The durable session's previous turn ended `completed`; reading it here would report success for
    // a turn that never ran.
    expect(events.at(-1)?.type).toBe("failed");
    const last = events.at(-1);
    if (last?.type === "failed") expect(last.details).toContain("without an assistant message");
  });
});
