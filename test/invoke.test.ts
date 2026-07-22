import { describe, expect, it, vi } from "vitest";
import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentTool,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, fauxThinking, fauxToolCall, Type, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { AssistantMessage, StopReason, Usage } from "@earendil-works/pi-ai";
import { defineTool, inMemorySessionStore, inProcessLease, type AgentEvent, z } from "../src/index.ts";
import { SESSION_BUSY_CODE } from "../src/agent.ts";
import { classifyRetryable, createPiAgentFromHarness, errorToTerminal, toTerminal } from "../src/engines/pi/invoke.ts";
import { type PiHarnessFactory, piHarnessFactory } from "../src/engines/pi/harness.ts";
import { makeFaux } from "./faux.ts";

/** An echo tool for the tool-call path. */
const echoTool: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "Echo back the input",
  parameters: Type.Object({ value: Type.String() }),
  async execute(_id, params) {
    const { value } = params as { value: string };
    return {
      content: [{ type: "text", text: value }],
      details: { echoed: value },
    };
  },
};

/** An agent bound to a faux model + shared store (→ continuity). Open-or-create per invoke. */
function makeAgent(responses: FauxResponseStep[]) {
  const { faux, models } = makeFaux();
  faux.setResponses(responses);
  const sessions = inMemorySessionStore();
  const agent = createPiAgentFromHarness({
    harnessFactory: piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      tools: [echoTool],
      systemPrompt: "test",
    }),
  });
  return { agent, sessions };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("invoke fan-in", () => {
  it("plain text produces exactly one completed terminal", async () => {
    const { agent } = makeAgent([fauxAssistantMessage("hello world")]);

    const events = await drain(agent.invoke({ session: "s1" }, { text: "hi" }));

    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as any).delta)
      .join("");
    expect(text).toBe("hello world");
    expect(events.at(-1)).toEqual({ type: "completed" });
    expect(events.filter((e) => e.type === "completed" || e.type === "failed")).toHaveLength(1);
  });

  it("maps model reasoning to thinking events, kept separate from the answer text", async () => {
    const { agent } = makeAgent([
      fauxAssistantMessage([fauxThinking("let me think"), { type: "text", text: "the answer" }]),
    ]);

    const events = await drain(agent.invoke({ session: "sT" }, { text: "hi" }));
    const thinking = events
      .filter((e) => e.type === "thinking")
      .map((e) => (e as any).delta)
      .join("");
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as any).delta)
      .join("");

    expect(thinking).toContain("let me think");
    expect(text).toBe("the answer"); // reasoning is not folded into the answer
  });

  it("binds the current read-only session manager to ordinary defineTool tools", async () => {
    let observed: { id: string; branch: SessionTreeEntry[] } | undefined;
    const inspectSession = defineTool({
      name: "inspect_session",
      description: "Inspect the current session.",
      input: z.object({}),
      async execute(_input, ctx) {
        if (!ctx.sessionManager) throw new Error("missing current session manager");
        observed = {
          id: ctx.sessionManager.getSessionId(),
          branch: await ctx.sessionManager.getBranch(),
        };
        return "inspected";
      },
    });
    const { faux, models } = makeFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("inspect_session", {}, { id: "inspect-1" })),
      fauxAssistantMessage("done"),
    ]);
    const agent = createPiAgentFromHarness({
      cwd: process.cwd(),
      harnessFactory: piHarnessFactory({
        sessions: inMemorySessionStore(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        models,
        model: faux.getModel(),
        tools: [inspectSession],
        systemPrompt: "test",
      }),
    });

    await drain(agent.invoke({ session: "history-session" }, { text: "inspect this conversation" }));

    expect(observed?.id).toBe("history-session");
    expect(JSON.stringify(observed?.branch)).toContain("inspect this conversation");
    expect(JSON.stringify(observed?.branch)).toContain("inspect_session");
  });

  it("preserves text → tool → completed order", async () => {
    const { agent } = makeAgent([
      fauxAssistantMessage(fauxToolCall("echo", { value: "ping" }, { id: "call-1" })),
      fauxAssistantMessage("done"),
    ]);

    const events = await drain(agent.invoke({ session: "s2" }, { text: "use echo" }));
    const types = events.map((e) => e.type);

    expect(types).toContain("tool_started");
    expect(types).toContain("tool_ended");
    expect(types.indexOf("tool_started")).toBeLessThan(types.indexOf("tool_ended"));
    expect(events.at(-1)?.type).toBe("completed");

    const started = events.find((e) => e.type === "tool_started") as any;
    expect(started.name).toBe("echo");
    expect(started.id).toBe("call-1");
    const ended = events.find((e) => e.type === "tool_ended") as any;
    expect(ended.id).toBe("call-1");
    expect(ended.isError).toBe(false);
  });

  it("model error resolves to failed terminal instead of throwing or omitting terminal", async () => {
    const { agent } = makeAgent([
      fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "rate limit 429" }),
    ]);

    const events = await drain(agent.invoke({ session: "s3" }, { text: "hi" }));
    const terminal = events.at(-1) as any;

    expect(terminal.type).toBe("failed");
    expect(terminal.details).toContain("429");
    expect(terminal.retryable).toBe(true);
  });

  it("consumer break cancels without terminal event and aborts the harness", async () => {
    let aborted = false;
    const repo = new InMemorySessionRepo();
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const agent = createPiAgentFromHarness({
      harnessFactory: async (sessionId: string) => {
        const { faux, models } = makeFaux();
        faux.setResponses([fauxAssistantMessage("a long answer streamed out")]);
        const session = await repo.create({ id: sessionId });
        const harness = new AgentHarness({
          env,
          session,
          models,
          model: faux.getModel(),
          systemPrompt: "test",
        });
        const origAbort = harness.abort.bind(harness);
        harness.abort = async () => {
          aborted = true;
          return origAbort();
        };
        return harness;
      },
    });

    const seen: AgentEvent[] = [];
    for await (const e of agent.invoke({ session: "s4" }, { text: "hi" })) {
      seen.push(e);
      break;
    }

    expect(seen.some((e) => e.type === "completed" || e.type === "failed")).toBe(false);
    expect(aborted).toBe(true);
  });

  it("cleanup never throws: abort() rejection in finally must not poison an already-terminal stream (MUST 2)", async () => {
    const repo = new InMemorySessionRepo();
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const agent = createPiAgentFromHarness({
      harnessFactory: async (sessionId: string) => {
        const { faux, models } = makeFaux();
        faux.setResponses([fauxAssistantMessage("done")]);
        const session = await repo.create({ id: sessionId });
        const harness = new AgentHarness({ env, session, models, model: faux.getModel(), systemPrompt: "test" });
        harness.abort = async () => {
          throw new Error("abort blew up"); // simulate an idle abort rejecting
        };
        return harness;
      },
    });

    // iteration must not throw, and the tail is still completed
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events = await drain(agent.invoke({ session: "sg" }, { text: "hi" }));
      expect(events.at(-1)).toEqual({ type: "completed" });
      // the swallowed-to-stream cleanup error is still surfaced visibly (fail visibly)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("abort blew up"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("prompt.images passthrough (SPEC §4)", () => {
  it("images reach the model context with the prompt", async () => {
    let seen: unknown;
    const { faux, models } = makeFaux({ models: [{ id: "faux-vision", input: ["text", "image"] }] });
    faux.setResponses([
      (context) => {
        seen = context.messages;
        return fauxAssistantMessage("saw it");
      },
    ]);
    const agent = createPiAgentFromHarness({
      harnessFactory: piHarnessFactory({
        sessions: inMemorySessionStore(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        models,
        model: faux.getModel(),
        systemPrompt: "test",
      }),
    });
    await drain(
      agent.invoke(
        { session: "img" },
        { text: "what is this?", images: [{ mimeType: "image/png", data: "aGVsbG8=" }] },
      ),
    );
    const dump = JSON.stringify(seen);
    expect(dump).toContain("aGVsbG8="); // base64 payload reached the context
    expect(dump).toContain('"image"');
  });
});

describe("session continuity (open instead of create)", () => {
  it("multiple turns in the same session: turn 2 sees turn 1 history", async () => {
    let turn2: unknown;
    const { agent } = makeAgent([
      fauxAssistantMessage("issue #42 is the login bug"),
      (context) => {
        turn2 = context.messages; // the context of the second request
        return fauxAssistantMessage("ok, fixing");
      },
    ]);

    await drain(agent.invoke({ session: "conv" }, { text: "triage issue #42" }));
    await drain(agent.invoke({ session: "conv" }, { text: "now fix it" }));

    const dump = JSON.stringify(turn2);
    expect(dump).toContain("triage issue #42"); // turn-1 user
    expect(dump).toContain("issue #42 is the login bug"); // turn-1 assistant
    expect(dump).toContain("now fix it"); // turn-2 user
  });

  it("different sessions do not leak into each other", async () => {
    let other: unknown;
    const { agent } = makeAgent([
      fauxAssistantMessage("the secret is hunter2"),
      (context) => {
        other = context.messages;
        return fauxAssistantMessage("nothing here");
      },
    ]);

    await drain(agent.invoke({ session: "A" }, { text: "remember the secret" }));
    await drain(agent.invoke({ session: "B" }, { text: "what do you know?" }));

    const dump = JSON.stringify(other);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("remember the secret");
    expect(dump).toContain("what do you know?"); // B's own prompt is present
  });
});

describe("lease + setup robustness", () => {
  it("harnessFactory throw becomes a failed event instead of throwing (MUST 2)", async () => {
    const agent = createPiAgentFromHarness({
      harnessFactory: async () => {
        throw new Error("cannot open session");
      },
    });
    const events = await drain(agent.invoke({ session: "z" }, { text: "hi" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed" });
    expect((events[0] as any).details).toContain("cannot open session");
  });

  it("cancel during the harness build never starts the model call — the latch is checked at arming", async () => {
    // The door (harness.abort) arms only after the build; a knock before prompt() would be a
    // no-op on an idle harness and the LATER run would ignore it — so the latched cancel must
    // instead prevent the run from starting at all, settling as aborted.
    const { faux, models } = makeFaux();
    faux.setResponses([fauxAssistantMessage("unreachable")]);
    const sessions = inMemorySessionStore();
    const inner = piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      systemPrompt: "test",
    });
    let releaseBuild!: () => void;
    const gate = new Promise<void>((r) => {
      releaseBuild = r;
    });
    let settled: unknown;
    const agent = createPiAgentFromHarness({
      harnessFactory: async (s) => {
        await gate; // the consumer cancels while the build is in flight
        return inner(s);
      },
      observer: (_s, event) => {
        if (event.type === "run_settled") settled = event.data;
      },
    });
    const iterator = agent.invoke({ session: "sBuildCancel" }, { text: "hi" })[Symbol.asyncIterator]();
    const first = iterator.next(); // parks inside the build
    const ret = iterator.return?.(undefined); // cancel during the build window
    releaseBuild();
    expect((await first).done).toBe(true); // no deadlock, no events — the run never started
    await ret;
    expect(settled).toMatchObject({ status: "aborted" });
    expect(faux.state.callCount).toBe(0); // the model was never called
  });

  it("createPiAgentFromHarness wraps invoke with the injected lease (acquire…release)", async () => {
    const calls: string[] = [];
    const { faux, models } = makeFaux();
    faux.setResponses([fauxAssistantMessage("ok")]);
    const agent = createPiAgentFromHarness({
      lease: {
        tryAcquire: (s) => {
          calls.push(`acq:${s}`);
          return () => calls.push(`rel:${s}`);
        },
      },
      harnessFactory: piHarnessFactory({
        sessions: inMemorySessionStore(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        models,
        model: faux.getModel(),
        systemPrompt: "test",
      }),
    });
    await drain(agent.invoke({ session: "z" }, { text: "hi" }));
    expect(calls).toEqual(["acq:z", "rel:z"]);
  });

  it("same-session concurrency: one completes, the other fail-fasts with 'session busy' (no queue, no reentry)", async () => {
    const { agent } = makeAgent([fauxAssistantMessage("first"), fauxAssistantMessage("should-not-run")]);
    const [ea, eb] = await Promise.all([
      drain(agent.invoke({ session: "x" }, { text: "a" })),
      drain(agent.invoke({ session: "x" }, { text: "b" })),
    ]);

    const completed = [ea, eb].filter((es) => es.at(-1)?.type === "completed");
    const busy = [ea, eb].filter((es) => es.some((e) => e.type === "failed" && /busy/.test((e as any).details)));
    expect(completed).toHaveLength(1); // exactly one completed
    expect(busy).toHaveLength(1); // exactly one busy
    expect(busy[0]).toHaveLength(1); // the busy one never ran a turn; a single failed event
    expect((busy[0]![0] as any).retryable).toBe(true);
    // Pin `code` at its SOURCE: the scheduler's replay-safe wake retry hinges on the busy reject carrying
    // this exact code (SPEC §8 subdivision). A refactor of this lease branch that drops/mistypes it must
    // fail HERE, not only in a real wake scenario (the scheduler test uses a hand-written code, not this).
    expect(busy[0]![0]).toMatchObject({ code: SESSION_BUSY_CODE });
  });

  it("busy is transient: same session can be used again after the previous turn completes", async () => {
    const { agent } = makeAgent([fauxAssistantMessage("first"), fauxAssistantMessage("later")]);
    await drain(agent.invoke({ session: "y" }, { text: "a" })); // completed serially
    const events = await drain(agent.invoke({ session: "y" }, { text: "b" }));
    expect(events.at(-1)?.type).toBe("completed"); // no longer busy
  });
});

describe("systemPrompt factory (re-evaluated per invoke)", () => {
  it("harnessFactory calls the factory each time so time-sensitive segments are not frozen at creation time", async () => {
    let calls = 0;
    const { faux, models } = makeFaux();
    faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    const agent = createPiAgentFromHarness({
      harnessFactory: piHarnessFactory({
        sessions: inMemorySessionStore(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        models,
        model: faux.getModel(),
        systemPrompt: () => `prompt v${++calls}`,
      }),
    });

    await drain(agent.invoke({ session: "p" }, { text: "one" }));
    await drain(agent.invoke({ session: "p" }, { text: "two" }));
    expect(calls).toBe(2); // evaluated once per invoke, not once per agent
  });
});

describe("inProcessLease (fail-fast single writer)", () => {
  it("occupied session makes the second tryAcquire return null (no queue)", () => {
    const lease = inProcessLease();
    const r1 = lease.tryAcquire("s");
    expect(r1).not.toBeNull();
    expect(lease.tryAcquire("s")).toBeNull(); // busy
    r1!();
    expect(lease.tryAcquire("s")).not.toBeNull(); // acquirable again after release
  });

  it("different sessions do not affect each other", () => {
    const lease = inProcessLease();
    expect(lease.tryAcquire("a")).not.toBeNull();
    expect(lease.tryAcquire("b")).not.toBeNull(); // b unaffected by a's occupancy
  });

  it("release is idempotent and does not release another holder", () => {
    const lease = inProcessLease();
    const r = lease.tryAcquire("s")!;
    r();
    r(); // double release is safe
    const r2 = lease.tryAcquire("s")!; // still acquirable normally
    expect(r2).not.toBeNull();
    // calling the stale release must not free r2's lease
    r();
    expect(lease.tryAcquire("s")).toBeNull(); // r2 still holds it
  });
});

describe("invoke: auto-compaction", () => {
  const usage = (input: number): Usage => ({
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  /** An agent over a fake harness: prompt resolves a completed message with the given usage; getModel
   *  reports the contextWindow; compact is a spy. (No real model — isolates the compaction decision.) */
  function compactingAgent(opts: {
    contextWindow: number;
    usage: Usage;
    compact: () => Promise<unknown>;
    stopReason?: StopReason;
  }) {
    const message = {
      role: "assistant",
      content: [],
      usage: opts.usage,
      stopReason: opts.stopReason ?? "stop",
    } as unknown as AssistantMessage;
    const harness = {
      subscribe: () => () => {},
      prompt: async () => message,
      getModel: () => ({ contextWindow: opts.contextWindow }),
      compact: opts.compact,
      abort: async () => ({}),
    };
    return createPiAgentFromHarness({ harnessFactory: (async () => harness) as unknown as PiHarnessFactory });
  }

  it("compacts after a completed turn when the context is over the threshold", async () => {
    const compact = vi.fn(async () => ({}));
    const agent = compactingAgent({ contextWindow: 1000, usage: usage(999_999), compact });
    const events = await drain(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(events.at(-1)).toEqual({ type: "completed" });
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("does not compact when the context is under the threshold", async () => {
    const compact = vi.fn(async () => ({}));
    const agent = compactingAgent({ contextWindow: 999_999, usage: usage(10), compact });
    await drain(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not compact when the turn fails (only a completed terminal triggers it)", async () => {
    const compact = vi.fn(async () => ({}));
    const agent = compactingAgent({ contextWindow: 1000, usage: usage(999_999), compact, stopReason: "error" });
    const events = await drain(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(events.at(-1)?.type).toBe("failed"); // the turn failed
    expect(compact).not.toHaveBeenCalled();
  });

  it("holds the session lease through compaction (a concurrent same-session turn is busy until it finishes)", async () => {
    let releaseCompact = (): void => {};
    const compactGate = new Promise<void>((r) => {
      releaseCompact = r;
    });
    const compact = vi.fn(async () => {
      await compactGate; // hold the turn inside compaction
    });
    const agent = compactingAgent({ contextWindow: 1000, usage: usage(999_999), compact });
    const turn1 = drain(agent.invoke({ session: "s" }, { text: "hi" }));
    for (let k = 0; k < 8; k++) await new Promise((r) => setImmediate(r)); // let turn1 reach compaction
    expect(compact).toHaveBeenCalledTimes(1); // turn1 is inside compaction — the lease is still held

    const events2 = await drain(agent.invoke({ session: "s" }, { text: "again" }));
    expect(events2.at(-1)).toMatchObject({ type: "failed", retryable: true }); // busy until compaction frees the lease

    releaseCompact();
    await turn1;
  });

  it("a compaction failure does not break the turn (it still completes)", async () => {
    const compact = vi.fn(async () => {
      throw new Error("summary failed");
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = compactingAgent({ contextWindow: 1000, usage: usage(999_999), compact });
    const events = await drain(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(events.at(-1)).toEqual({ type: "completed" }); // turn still completed
    expect(compact).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/auto-compaction failed/));
  });
});

describe("classifyRetryable (structured signal first, prose as last resort)", () => {
  it("uses HTTP status when present: 429/5xx retryable, other statuses decisively not", () => {
    // A status wins even when the message prose would match — no false positive from wording.
    expect(classifyRetryable("bad request mentioning timeout", { status: 400 })).toBe(false);
    expect(classifyRetryable("nope", { status: 429 })).toBe(true);
    expect(classifyRetryable("nope", { status: 503 })).toBe(true);
    expect(classifyRetryable("nope", { status: 401 })).toBe(false);
  });

  it("uses a network/error code when present (string or numeric status-as-code)", () => {
    expect(classifyRetryable("x", { code: "ECONNRESET" })).toBe(true);
    expect(classifyRetryable("x", { code: "ETIMEDOUT" })).toBe(true);
    expect(classifyRetryable("x", { code: "429" })).toBe(true);
    expect(classifyRetryable("x", { code: 503 })).toBe(true);
    expect(classifyRetryable("x", { code: "ENOENT" })).toBe(false); // unknown code, prose "x" → false
  });

  it("falls back to message prose only when no structured signal exists", () => {
    expect(classifyRetryable("model is overloaded, try again", {})).toBe(true);
    expect(classifyRetryable("request timed out", {})).toBe(true);
    expect(classifyRetryable("invalid api key", {})).toBe(false);
  });
});

describe("terminal signal extraction (pins the pi shapes classifyRetryable reads)", () => {
  // A failed AssistantMessage: only diagnostics[].error.code is available (no HTTP status field).
  const errorMessage = (over: Partial<AssistantMessage>): AssistantMessage =>
    ({ role: "assistant", stopReason: "error", ...over }) as unknown as AssistantMessage;

  it("toTerminal reads diagnostics[].error.code as a status, overriding the prose", () => {
    const msg = errorMessage({
      errorMessage: "the model said something unrecognizable", // prose alone → not retryable
      diagnostics: [{ type: "stream_error", timestamp: 0, error: { message: "m", code: 503 } }],
    });
    expect(toTerminal(msg)).toEqual({ type: "failed", details: expect.any(String), retryable: true });
  });

  it("toTerminal uses the LAST code-bearing diagnostic (terminal cause), not an earlier attempt's", () => {
    // An earlier attempt logged a transient 503; the terminal cause is a fatal 400 — must be non-retryable.
    const msg = errorMessage({
      errorMessage: "bad request",
      diagnostics: [
        { type: "stream_error", timestamp: 0, error: { message: "transient", code: 503 } },
        { type: "api_error", timestamp: 1, error: { message: "fatal", code: 400 } },
      ],
    });
    expect((toTerminal(msg) as { retryable: boolean }).retryable).toBe(false);
  });

  it("toTerminal: a provider string code is not decisive, so it falls to prose", () => {
    const msg = errorMessage({
      errorMessage: "quota exhausted", // no retryable token → false
      diagnostics: [{ type: "api_error", timestamp: 0, error: { message: "m", code: "insufficient_quota" } }],
    });
    expect((toTerminal(msg) as { retryable: boolean }).retryable).toBe(false);
  });

  it("toTerminal on a clean stop is completed", () => {
    expect(toTerminal(errorMessage({ stopReason: "stop" }))).toEqual({ type: "completed" });
  });

  it("errorToTerminal reads .status / .statusCode / .cause.code off a thrown error", () => {
    expect((errorToTerminal(Object.assign(new Error("x"), { status: 500 })) as { retryable: boolean }).retryable).toBe(
      true,
    );
    expect(
      (errorToTerminal(Object.assign(new Error("x"), { statusCode: 400 })) as { retryable: boolean }).retryable,
    ).toBe(false); // a decisive non-5xx status wins over any prose
    expect(
      (errorToTerminal(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } })) as { retryable: boolean })
        .retryable,
    ).toBe(true);
    expect((errorToTerminal(new Error("plain failure")) as { retryable: boolean }).retryable).toBe(false);
  });
});
