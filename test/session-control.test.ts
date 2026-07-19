/**
 * Session control plane, Phase 1 (observation plane) conformance — docs/design/session-control.md:
 * projection fidelity (AgentEvent is a projection of the rich stream), ordering, run boundaries
 * (exactly one run_settled per run_started, incl. caller cancellation), reconnect (entries cursor +
 * state), read-only observation (no session creation), and acceptance-vs-outcome on dispatch.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type, type FauxResponseStep, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { createPiSessionControl } from "../src/engines/pi/session-control.ts";
import { inMemorySessionStore } from "../src/engines/pi/sessions.ts";
import { UNSUPPORTED_CAPABILITY_CODE, type SessionEvent } from "../src/session.ts";
import { makeFaux } from "./faux.ts";

const echoTool: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "Echo back the input",
  parameters: Type.Object({ value: Type.String() }),
  async execute(_id, params) {
    const { value } = params as { value: string };
    return { content: [{ type: "text", text: value }], details: { echoed: value } };
  },
};

/** Agent + control over ONE shared store — the wiring `createPiSessionControl`'s doc prescribes. */
function makeObserved(responses: FauxResponseStep[]) {
  const { faux, models } = makeFaux();
  faux.setResponses(responses);
  const sessions = inMemorySessionStore();
  const { control, observer } = createPiSessionControl({ sessions });
  const agent = createPiAgentFromHarness({
    observer,
    harnessFactory: piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      tools: [echoTool],
      systemPrompt: "test",
    }),
  });
  return { agent, control, sessions };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Collect the observation stream concurrently with a run; stop once `run_settled` arrives. */
async function watchUntilSettled(control: ReturnType<typeof makeObserved>["control"], session: string) {
  const seen: SessionEvent[] = [];
  for await (const ev of control.events(session)) {
    seen.push(ev);
    if (ev.type === "run_settled") break;
  }
  return seen;
}

describe("session control (Phase 1): observation plane", () => {
  it("run boundaries + projection fidelity: the invoke stream is a projection of the rich stream", async () => {
    const { agent, control } = makeObserved([
      fauxAssistantMessage([fauxThinking("hmm"), { type: "text", text: "answer" }]),
    ]);
    const watched = watchUntilSettled(control, "s1");
    const invoked = await drain(agent.invoke({ session: "s1" }, { text: "hi" }));
    const rich = await watched;

    // Run boundaries: exactly one started and one settled, same runId, settled last.
    const started = rich.filter((e) => e.type === "run_started");
    const settled = rich.filter((e) => e.type === "run_settled");
    expect(started).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.runId).toBe(started[0]?.runId);
    expect(rich.at(-1)?.type).toBe("run_settled");
    expect(settled[0]?.data).toEqual({ status: "completed" });
    // Every run-scoped event carries the run's id (ordering/grouping identity).
    for (const e of rich) expect(e.runId).toBe(started[0]?.runId);

    // Projection fidelity: text/thinking deltas equal on both planes, channel distinction preserved.
    const richText = rich
      .filter((e) => e.type === "message_delta" && (e.data as { channel: string }).channel === "text")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    const richThinking = rich
      .filter((e) => e.type === "message_delta" && (e.data as { channel: string }).channel === "thinking")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    const invokedText = invoked
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(richText).toBe("answer");
    expect(richText).toBe(invokedText);
    expect(richThinking).toBe("hmm");
    // Rich-only vocabulary exists (message boundaries), and it wraps the deltas in order.
    const types = rich.map((e) => e.type);
    expect(types.indexOf("message_started")).toBeGreaterThan(types.indexOf("run_started"));
    expect(types.lastIndexOf("message_finished")).toBeLessThan(types.indexOf("run_settled"));
  });

  it("tool events cross both planes; tool_finished projects to tool_ended", async () => {
    const { agent, control } = makeObserved([
      fauxAssistantMessage(fauxToolCall("echo", { value: "ping" }, { id: "call-1" })),
      fauxAssistantMessage("done"),
    ]);
    const watched = watchUntilSettled(control, "sT");
    const invoked = await drain(agent.invoke({ session: "sT" }, { text: "go" }));
    const rich = await watched;

    const toolStarted = rich.find((e) => e.type === "tool_started")?.data as { name: string };
    const toolFinished = rich.find((e) => e.type === "tool_finished")?.data as { isError: boolean };
    expect(toolStarted.name).toBe("echo");
    expect(toolFinished.isError).toBe(false);
    expect(invoked.some((e) => e.type === "tool_started" && e.name === "echo")).toBe(true);
    expect(invoked.some((e) => e.type === "tool_ended" && e.id === "call-1")).toBe(true);
  });

  it("caller cancellation still settles the run (exactly-one run_settled: aborted)", async () => {
    const { agent, control } = makeObserved([fauxAssistantMessage("a long answer")]);
    const watched = watchUntilSettled(control, "sC");
    // Cancel mid-stream: break out of iteration on the first event (SPEC: no terminal for the caller).
    for await (const e of agent.invoke({ session: "sC" }, { text: "hi" })) {
      if (e.type === "text") break;
    }
    const rich = await watched;
    const settled = rich.filter((e) => e.type === "run_settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.data).toMatchObject({ status: "aborted" });
  });

  it("failed setup surfaces as run_settled{failed} with the failure detail", async () => {
    const sessions = inMemorySessionStore();
    const { control, observer } = createPiSessionControl({ sessions });
    const agent = createPiAgentFromHarness({
      observer,
      harnessFactory: async () => {
        throw new Error("boom: no auth");
      },
    });
    const watched = watchUntilSettled(control, "sF");
    const invoked = await drain(agent.invoke({ session: "sF" }, { text: "hi" }));
    const rich = await watched;

    expect(invoked.at(-1)?.type).toBe("failed");
    const settled = rich.find((e) => e.type === "run_settled")?.data as {
      status: string;
      error: { message: string };
    };
    expect(settled.status).toBe("failed");
    expect(settled.error.message).toContain("boom");
  });

  it("session_busy is rejected before acceptance: the observation plane sees no second run", async () => {
    const { agent, control } = makeObserved([fauxAssistantMessage("slow answer"), fauxAssistantMessage("second")]);
    const events: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("sB")) {
        events.push(ev);
        if (ev.type === "run_settled") break;
      }
    })();
    // Start a run; while its first event is in flight, a second invoke must fail fast.
    const first = agent.invoke({ session: "sB" }, { text: "one" });
    const iter = first[Symbol.asyncIterator]();
    await iter.next(); // the run is now active (lease held)
    const second = await drain(agent.invoke({ session: "sB" }, { text: "two" }));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: "failed", code: "session_busy" });
    // Drain the first run to completion.
    while (!(await iter.next()).done) {
      /* drain */
    }
    await watching;
    expect(events.filter((e) => e.type === "run_started")).toHaveLength(1);
  });

  it("state(): running with activeRunId during the run, idle with a leaf after it", async () => {
    const { agent, control } = makeObserved([fauxAssistantMessage("ok")]);
    // Unknown session: idle, empty — and NOT created by observing it (read-only plane).
    expect(await control.state("nope")).toEqual({ status: "idle", pending: { steering: 0, followUp: 0 } });

    const iter = agent.invoke({ session: "sS" }, { text: "hi" })[Symbol.asyncIterator]();
    await iter.next();
    const during = await control.state("sS");
    expect(during.status).toBe("running");
    expect(during.activeRunId).toBeTruthy();
    while (!(await iter.next()).done) {
      /* drain */
    }
    const after = await control.state("sS");
    expect(after.status).toBe("idle");
    expect(after.activeRunId).toBeUndefined();
    expect(after.leafEntryId).toBeTruthy();
  });

  it("entries(): durable reconnect — kinds, cursor, and leaf; observation never creates a session", async () => {
    const { agent, control, sessions } = makeObserved([
      fauxAssistantMessage(fauxToolCall("echo", { value: "x" }, { id: "c1" })),
      fauxAssistantMessage("final answer"),
    ]);
    // Unknown session reads as empty — and does not spring into existence.
    expect(await control.entries("ghost")).toEqual({ entries: [] });
    expect(await sessions.openIfExists("ghost")).toBeUndefined();

    await drain(agent.invoke({ session: "sE" }, { text: "question" }));
    const all = await control.entries("sE");
    const kinds = all.entries.map((e) => e.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
    expect(kinds).toContain("tool");
    expect(all.leafEntryId).toBe(all.entries.at(-1)?.id);
    // Render payloads: the guaranteed minimum vocabulary carries text.
    const user = all.entries.find((e) => e.kind === "user")?.data as { text: string };
    expect(user.text).toBe("question");
    const tool = all.entries.find((e) => e.kind === "tool")?.data as { toolName: string };
    expect(tool.toolName).toBe("echo");

    // Cursor: entries after `since` only; unknown cursor falls back to full backfill.
    const mid = all.entries[1]?.id as string;
    const after = await control.entries("sE", { since: mid });
    expect(after.entries).toEqual(all.entries.slice(2));
    const unknown = await control.entries("sE", { since: "no-such-id" });
    expect(unknown.entries).toEqual(all.entries);
  });

  it("events(): multiple observers see the same stream; unsubscribe is per-consumer", async () => {
    const { agent, control } = makeObserved([fauxAssistantMessage("shared")]);
    const a = watchUntilSettled(control, "sM");
    const b = watchUntilSettled(control, "sM");
    await drain(agent.invoke({ session: "sM" }, { text: "hi" }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.map((e) => e.type)).toEqual(rb.map((e) => e.type));
    expect(ra.at(-1)?.type).toBe("run_settled");
  });

  it("dispatch(): Phase 1 rejects every command before acceptance with the stable code", async () => {
    const { control } = makeObserved([]);
    const result = await control.dispatch("sD", { type: "abort" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(UNSUPPORTED_CAPABILITY_CODE);
      expect(result.error.retryable).toBe(false);
    }
    // And capabilities honestly gate them off.
    const caps = control.capabilities();
    expect(caps.steering).toBe(false);
    expect(caps.followUp).toBe(false);
    expect(caps.toolProgress).toBe(true);
  });
});
