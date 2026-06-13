import { describe, expect, it } from "vitest";
import { AgentHarness, InMemorySessionRepo, type AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { inMemorySessionStore, inProcessLease, type AgentEvent } from "../src/index.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";

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
  const faux = registerFauxProvider();
  faux.setResponses(responses);
  const sessions = inMemorySessionStore();
  const agent = createPiAgentFromHarness({
    harnessFactory: piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
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

    const text = events.filter((e) => e.type === "text").map((e) => (e as any).delta).join("");
    expect(text).toBe("hello world");
    expect(events.at(-1)).toEqual({ type: "completed" });
    expect(events.filter((e) => e.type === "completed" || e.type === "failed")).toHaveLength(1);
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
        const faux = registerFauxProvider();
        faux.setResponses([fauxAssistantMessage("a long answer streamed out")]);
        const session = await repo.create({ id: sessionId });
        const harness = new AgentHarness({
          env,
          session,
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
        const faux = registerFauxProvider();
        faux.setResponses([fauxAssistantMessage("done")]);
        const session = await repo.create({ id: sessionId });
        const harness = new AgentHarness({ env, session, model: faux.getModel(), systemPrompt: "test" });
        harness.abort = async () => {
          throw new Error("abort blew up"); // simulate an idle abort rejecting
        };
        return harness;
      },
    });

    // iteration must not throw, and the tail is still completed
    const events = await drain(agent.invoke({ session: "sg" }, { text: "hi" }));
    expect(events.at(-1)).toEqual({ type: "completed" });
  });
});

describe("prompt.images passthrough (SPEC §4)", () => {
  it("images reach the model context with the prompt", async () => {
    let seen: unknown;
    const faux = registerFauxProvider({ models: [{ id: "faux-vision", input: ["text", "image"] }] });
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

  it("createPiAgentFromHarness wraps invoke with the injected lease (acquire…release)", async () => {
    const calls: string[] = [];
    const faux = registerFauxProvider();
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
        model: faux.getModel(),
        systemPrompt: "test",
      }),
    });
    await drain(agent.invoke({ session: "z" }, { text: "hi" }));
    expect(calls).toEqual(["acq:z", "rel:z"]);
  });

  it("same-session concurrency: one completes, the other fail-fasts with 'session busy' (no queue, no reentry)", async () => {
    const { agent } = makeAgent([
      fauxAssistantMessage("first"),
      fauxAssistantMessage("should-not-run"),
    ]);
    const [ea, eb] = await Promise.all([
      drain(agent.invoke({ session: "x" }, { text: "a" })),
      drain(agent.invoke({ session: "x" }, { text: "b" })),
    ]);

    const completed = [ea, eb].filter((es) => es.at(-1)?.type === "completed");
    const busy = [ea, eb].filter((es) =>
      es.some((e) => e.type === "failed" && /busy/.test((e as any).details)),
    );
    expect(completed).toHaveLength(1); // exactly one completed
    expect(busy).toHaveLength(1); // exactly one busy
    expect(busy[0]).toHaveLength(1); // the busy one never ran a turn; a single failed event
    expect((busy[0]![0] as any).retryable).toBe(true);
  });

  it("busy is transient: same session can be used again after the previous turn completes", async () => {
    const { agent } = makeAgent([
      fauxAssistantMessage("first"),
      fauxAssistantMessage("later"),
    ]);
    await drain(agent.invoke({ session: "y" }, { text: "a" })); // completed serially
    const events = await drain(agent.invoke({ session: "y" }, { text: "b" }));
    expect(events.at(-1)?.type).toBe("completed"); // no longer busy
  });
});

describe("systemPrompt factory (re-evaluated per invoke)", () => {
  it("harnessFactory calls the factory each time so time-sensitive segments are not frozen at creation time", async () => {
    let calls = 0;
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    const agent = createPiAgentFromHarness({
      harnessFactory: piHarnessFactory({
        sessions: inMemorySessionStore(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        model: faux.getModel(),
        systemPrompt: () => `prompt v${++calls}`,
      }),
    });

    await drain(agent.invoke({ session: "p" }, { text: "one" }));
    await drain(agent.invoke({ session: "p" }, { text: "two" }));
    expect(calls).toBe(2); // evaluated once per invoke, not once per agent
  });
});

describe("retryClassifier injection (failed.retryable policy is replaceable)", () => {
  it("injected policy overrides the default string heuristic", async () => {
    const faux = registerFauxProvider();
    // "weird custom failure" does not match the default regex, so the default would be retryable:false
    faux.setResponses([
      fauxAssistantMessage("x", { stopReason: "error", errorMessage: "weird custom failure" }),
    ]);
    const agent = createPiAgentFromHarness({
      retryClassifier: () => true,
      harnessFactory: piHarnessFactory({
        sessions: inMemorySessionStore(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        model: faux.getModel(),
        systemPrompt: "test",
      }),
    });

    const events = await drain(agent.invoke({ session: "r" }, { text: "hi" }));
    expect(events.at(-1)).toMatchObject({ type: "failed", retryable: true });
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
