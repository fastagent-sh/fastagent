/**
 * The AgentSession L0's own turn-boundary discipline. The conformance suite drives a real engine;
 * this drives a stub, because the case that matters — a run that settles without producing anything —
 * is exactly what a healthy engine never does.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  ModelRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { createPiAgentFromSession } from "../src/engines/pi/invoke-session.ts";
import { piInMemorySessionRecordStore } from "../src/engines/pi/session-store.ts";
import type { RunControls } from "../src/engines/pi/turn-kit.ts";
import type { SessionEvent } from "../src/session.ts";
import { makeFaux } from "./faux.ts";
import { log } from "../src/log.ts";

/** Runs inside prompt-option resolution — the window between "the session exists" and "the model
 *  call starts", which a test cannot otherwise reach. */
const duringPromptPrep = vi.hoisted(() => ({ value: null as null | (() => Promise<void>) }));

vi.mock("../src/engines/pi/turn-kit.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/engines/pi/turn-kit.ts")>();
  return {
    ...actual,
    toPiPromptOptions: async (prompt: Parameters<typeof actual.toPiPromptOptions>[0]) => {
      await duringPromptPrep.value?.();
      return actual.toPiPromptOptions(prompt);
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

afterEach(() => {
  duringPromptPrep.value = null;
});

describe("AgentSession L0: the terminal describes THIS turn", () => {
  it("a run that ends no assistant message fails, however complete the session's history looks", async () => {
    const agent = createPiAgentFromSession({ sessionFactory: async () => silentSessionAfterHistory() });
    const events = await drain(agent.invoke({ session: "durable" }, { text: "turn two" }));
    // The session state holds a previous turn that ended `completed`. Deriving the terminal from that
    // state - at any index, since compaction and overflow recovery both rewrite the array mid-turn -
    // would report success for a turn that produced nothing.
    expect(events.at(-1)?.type).toBe("failed");
    const last = events.at(-1);
    if (last?.type === "failed") expect(last.details).toContain("without ending an assistant message");
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
    // Park the generator INSIDE prompt-option resolution: the session exists and is idle, so the
    // armed door has nothing to abort — only a latch read after this await can stop the turn.
    let leaveTheWindow!: () => void;
    let entered!: () => void;
    const inTheWindow = new Promise<void>((resolve) => (entered = resolve));
    duringPromptPrep.value = () => {
      entered();
      return new Promise<void>((resolve) => (leaveTheWindow = resolve));
    };

    const iterator = agent.invoke({ session: "resize-cancel" }, { text: "go" })[Symbol.asyncIterator]();
    const first = iterator.next();
    await inTheWindow;
    const cancelled = iterator.return?.(undefined);
    leaveTheWindow();
    await cancelled;

    expect((await first).done).toBe(true);
    expect(prompted()).toBe(false);
  });

  it("a cancelled consumer gets no terminal, even when preparing the prompt then fails", async () => {
    const { session, prompted } = promptRecordingSession();
    const agent = createPiAgentFromSession({ sessionFactory: async () => session });
    let failPreparation!: () => void;
    let entered!: () => void;
    const inTheWindow = new Promise<void>((resolve) => (entered = resolve));
    duringPromptPrep.value = () => {
      entered();
      return new Promise<void>(
        (_, reject) => (failPreparation = () => reject(new Error("image pipeline unavailable"))),
      );
    };

    const iterator = agent.invoke({ session: "cancel-then-fail" }, { text: "go" })[Symbol.asyncIterator]();
    const first = iterator.next();
    await inTheWindow;
    const cancelled = iterator.return?.(undefined);
    failPreparation(); // the failure races the cancellation, and loses: nobody is listening
    await cancelled;

    expect((await first).done).toBe(true);
    expect(prompted()).toBe(false);
  });

  it("a failure while preparing the prompt is one failed terminal, not a thrown iteration", async () => {
    const { session, prompted } = promptRecordingSession();
    const agent = createPiAgentFromSession({ sessionFactory: async () => session });
    duringPromptPrep.value = () => Promise.reject(new Error("image pipeline unavailable"));

    const events = await drain(agent.invoke({ session: "prep-failure" }, { text: "go" }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed", details: "image pipeline unavailable" });
    expect(prompted()).toBe(false);
  });
});

describe("AgentSession L0: the observation plane", () => {
  it.each([
    ["auto_retry_start", "assistant"],
    ["summarization_retry_scheduled", "compaction"],
  ] as const)("projects %s with its operation and run identity", async (type, operation) => {
    let emit!: (event: AgentSessionEvent) => void;
    const session = {
      ...promptRecordingSession().session,
      subscribe: (listener: typeof emit) => {
        emit = listener;
        return () => {};
      },
      prompt: async () => {
        emit({ type, attempt: 2, maxAttempts: 3, delayMs: 125, errorMessage: "temporarily unavailable" });
        emit({ type: "message_end", message: fauxAssistantMessage("done") });
      },
    } as unknown as AgentSession;
    const seen: SessionEvent[] = [];
    const agent = createPiAgentFromSession({
      sessionFactory: async () => session,
      observer: (_id, event) => seen.push(event),
    });
    const events = await drain(agent.invoke({ session: "retry" }, { text: "hi" }));
    expect(seen.find((event) => event.type === "retry_scheduled")).toEqual({
      type: "retry_scheduled",
      timestamp: expect.any(Number),
      runId: seen[0]?.runId,
      data: { operation, attempt: 2, maxAttempts: 3, delayMs: 125, error: "temporarily unavailable" },
    });
    expect(events).toEqual([
      { type: "retrying", attempt: 2, maxAttempts: 3, delayMs: 125, reason: "temporarily unavailable" },
      { type: "completed" },
    ]);
  });

  it.each(["threshold", "overflow"] as const)("logs %s recovery without changing the turn outcome", async (reason) => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    let emit: (event: AgentSessionEvent) => void = () => {};
    const message = {
      ...fauxAssistantMessage("recovered"),
      diagnostics: [
        { type: "anthropic_input_transformations", timestamp: 1, details: { privatePayload: "do-not-log" } },
      ],
    };
    const session = {
      ...promptRecordingSession().session,
      subscribe: (listener: typeof emit) => {
        emit = listener;
        return () => {};
      },
      prompt: async () => {
        emit({
          type: "compaction_end",
          reason,
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage: "summary failed",
        });
        emit({
          type: "compaction_end",
          reason,
          result: undefined,
          aborted: true,
          willRetry: false,
          errorMessage: "cancelled",
        });
        emit({ type: "message_end", message });
      },
    } as unknown as AgentSession;
    const seen: SessionEvent[] = [];
    const agent = createPiAgentFromSession({
      sessionFactory: async () => session,
      observer: (_id, event) => seen.push(event),
    });
    try {
      const events = await drain(agent.invoke({ session: "recovery" }, { text: "hi" }));
      expect(events.at(-1)).toEqual({ type: "completed" });
      expect(seen.some((e) => e.type === "compaction_started" || e.type === "compaction_finished")).toBe(false);
      expect(warn.mock.calls).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`automatic compaction ${reason}`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider diagnostic anthropic_input_transformations"));
      expect(JSON.stringify(warn.mock.calls)).toContain("session recovery, run");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("do-not-log");
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("aborted"));
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });

  it("publishes one run, its rich events, and exactly one settlement", async () => {
    const { faux } = makeFaux();
    faux.setResponses([fauxAssistantMessage("hello there")]);
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const cwd = process.cwd();
    const services = await createAgentSessionServices({
      cwd,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noPromptTemplates: true,
        noContextFiles: true,
        systemPromptOverride: () => "test",
        appendSystemPromptOverride: () => [],
        skillsOverride: (base) => ({ skills: [], diagnostics: base.diagnostics }),
      },
    });
    const store = piInMemorySessionRecordStore({ cwd });
    const seen: SessionEvent[] = [];
    let controls: RunControls | undefined;
    const agent = createPiAgentFromSession({
      observer: (_session, event, run) => {
        seen.push(event);
        if (run) controls = run;
      },
      sessionFactory: async (id) =>
        (
          await createAgentSessionFromServices({
            services,
            sessionManager: await store.openOrCreate(id),
            model: faux.getModel(),
            noTools: "all",
          })
        ).session,
    });

    await drain(agent.invoke({ session: "observed" }, { text: "hi" }));

    const types = seen.map((e) => e.type);
    expect(types.filter((t) => t === "run_started")).toHaveLength(1);
    expect(types.filter((t) => t === "run_settled")).toHaveLength(1);
    expect(types.at(-1)).toBe("run_settled"); // the settlement closes the run
    expect(types).toContain("message_started");
    expect(types).toContain("message_delta");
    expect(types).toContain("message_finished");
    expect(seen.at(-1)).toMatchObject({ data: { status: "completed" } });
    // Every run event carries the run's identity, and the controls arrive with run_started.
    expect(new Set(seen.filter((e) => "runId" in e).map((e) => (e as { runId: string }).runId)).size).toBe(1);
    expect(controls).toBeDefined();
  });

  it("a command dispatched after settlement is refused, not silently accepted", async () => {
    const { session, prompted } = promptRecordingSession();
    void prompted;
    let controls: RunControls | undefined;
    const agent = createPiAgentFromSession({
      observer: (_s, _e, run) => {
        if (run) controls = run;
      },
      sessionFactory: async () => session,
    });

    await drain(agent.invoke({ session: "settled" }, { text: "hi" }));

    await expect(controls?.steer({ text: "too late" })).rejects.toThrow(/already settled/);
    await expect(controls?.abort()).rejects.toThrow(/already settled/);
  });
});
