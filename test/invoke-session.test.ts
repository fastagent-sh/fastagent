/**
 * The AgentSession L0's own turn-boundary discipline. The conformance suite drives a real engine;
 * this drives a stub, because the case that matters — a run that settles without producing anything —
 * is exactly what a healthy engine never does.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { createPiAgentFromSession } from "../src/engines/pi/invoke-session.ts";

/** Holds prompt-option resolution open, so a cancellation can land in that exact window. */
const optionsGate = vi.hoisted(() => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open: () => open(), enabled: { value: false }, failure: { value: null as Error | null } };
});

vi.mock("../src/engines/pi/invoke.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/engines/pi/invoke.ts")>();
  return {
    ...actual,
    toPiPromptOptions: async (prompt: unknown) => {
      if (optionsGate.enabled.value) await optionsGate.gate;
      if (optionsGate.failure.value) throw optionsGate.failure.value;
      return actual.toPiPromptOptions(prompt as Parameters<typeof actual.toPiPromptOptions>[0]);
    },
  };
});

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

/** Records whether the model call was ever started. */
function promptRecordingSession(): { session: AgentSession; prompted: () => boolean } {
  let prompted = false;
  const session = {
    state: { messages: [] },
    subscribe: () => () => {},
    prompt: async () => {
      prompted = true;
    },
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession;
  return { session, prompted: () => prompted };
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

describe("AgentSession L0: cancelling before the model call", () => {
  it("never starts the turn when the consumer walks away while the session is being prepared", async () => {
    const { session, prompted } = promptRecordingSession();
    const agent = createPiAgentFromSession({ sessionFactory: async () => session });
    const iterator = agent.invoke({ session: "early-cancel" }, { text: "go" })[Symbol.asyncIterator]();
    // The consumer leaves before the first event exists — the window where the cancellation door is
    // armed but the session is still idle, so knocking on it does nothing.
    const first = iterator.next();
    await iterator.return?.(undefined);
    const settled = await first;
    expect(prompted()).toBe(false);
    expect(settled.done).toBe(true); // cancellation has no terminal event (SPEC MUST 3)
  });

  it("never starts the turn when the consumer walks away while the prompt's images are resized", async () => {
    const { session, prompted } = promptRecordingSession();
    const agent = createPiAgentFromSession({ sessionFactory: async () => session });
    optionsGate.enabled.value = true;
    try {
      const iterator = agent.invoke({ session: "resize-cancel" }, { text: "go" })[Symbol.asyncIterator]();
      const first = iterator.next();
      // Park the generator INSIDE prompt-option resolution: the session exists and is idle, so the
      // armed door has nothing to abort — only a latch read after this await can stop the turn.
      await Promise.resolve();
      const cancelled = iterator.return?.(undefined);
      optionsGate.open();
      await cancelled;
      expect((await first).done).toBe(true);
      expect(prompted()).toBe(false);
    } finally {
      optionsGate.enabled.value = false;
    }
  });

  it("a failure while preparing the prompt is one failed terminal, not a thrown iteration", async () => {
    const { session, prompted } = promptRecordingSession();
    const agent = createPiAgentFromSession({ sessionFactory: async () => session });
    optionsGate.failure.value = new Error("image pipeline unavailable");
    try {
      const events = await drain(agent.invoke({ session: "prep-failure" }, { text: "go" }));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "failed", details: "image pipeline unavailable" });
      expect(prompted()).toBe(false);
    } finally {
      optionsGate.failure.value = null;
    }
  });
});
