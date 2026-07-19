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
import { ABORTED_CODE, type AgentEvent } from "../src/agent.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { createPiSessionControl } from "../src/engines/pi/session-control.ts";
import { inMemorySessionStore } from "../src/engines/pi/sessions.ts";
import { createPiAgentFromWorkspace } from "../src/engines/pi/workspace.ts";
import {
  NO_ACTIVE_RUN_CODE,
  RUN_COMMAND_FAILED_CODE,
  UNSUPPORTED_CAPABILITY_CODE,
  type SessionEvent,
} from "../src/session.ts";
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

  it("openIfExists is strictly read-only: no crash reconciliation, no repair entries", async () => {
    const sessions = inMemorySessionStore();
    // Simulate a turn that died mid tool-execution: assistant(toolCall) persisted, NO result.
    const s = await sessions.openOrCreate("crashed");
    await s.appendMessage({
      role: "user",
      content: [{ type: "text", text: "run it" }],
      timestamp: Date.now(),
    } as never);
    await s.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "x" } }],
      provider: "faux",
      model: "faux",
      stopReason: "toolUse",
      usage: { input: 0, output: 0 },
      timestamp: Date.now(),
    } as never);

    // The READ path must not append the interrupted-tool-call repair (that is a write).
    const observed = await sessions.openIfExists("crashed");
    const entriesAfterRead = await observed?.getEntries();
    const repairIn = (entries: { type: string }[] | undefined) =>
      (entries ?? []).filter(
        (e) =>
          e.type === "message" &&
          (e as unknown as { message: { details?: { fastagent?: string } } }).message.details?.fastagent ===
            "interrupted-tool-call",
      );
    expect(repairIn(entriesAfterRead)).toHaveLength(0);

    // The WRITE path (openOrCreate) still reconciles — the guarantee lives there, not in the reader.
    const reopened = await sessions.openOrCreate("crashed");
    expect(repairIn(await reopened.getEntries())).toHaveLength(1);
  });

  it("a throwing observer never breaks the data plane", async () => {
    const { faux, models } = makeFaux();
    faux.setResponses([fauxAssistantMessage("resilient")]);
    const agent = createPiAgentFromHarness({
      observer: () => {
        throw new Error("broken hub");
      },
      harnessFactory: piHarnessFactory({
        sessions: inMemorySessionStore(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        models,
        model: faux.getModel(),
        systemPrompt: "test",
      }),
    });
    const invoked = await drain(agent.invoke({ session: "sX" }, { text: "hi" }));
    expect(invoked.at(-1)).toEqual({ type: "completed" });
    const text = invoked
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toBe("resilient");
  });

  it("workspace opener wires the hub itself (sessionControl: true) — the seam is executable", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "fa-sc-ws-"));
    try {
      await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      const opened = await createPiAgentFromWorkspace(dir, { sessionControl: true });
      expect(opened.sessionControl).toBeDefined();
      const control = opened.sessionControl as NonNullable<typeof opened.sessionControl>;
      // The control is live over this workspace's (jsonl) store: read-only observation works
      // without a single model call, and an unknown session stays uncreated.
      expect(await control.state("ghost")).toEqual({ status: "idle", pending: { steering: 0, followUp: 0 } });
      expect(await control.entries("ghost")).toEqual({ entries: [] });
      expect(await opened.sessions.openIfExists("ghost")).toBeUndefined();
      // Not requested → not built.
      const plain = await createPiAgentFromWorkspace(dir, {});
      expect(plain.sessionControl).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dispatch(): boundary mutations still reject with unsupported_capability; run commands on idle reject with no_active_run", async () => {
    const { control } = makeObserved([]);
    const compact = await control.dispatch("sD", { type: "compact" });
    expect(compact.ok).toBe(false);
    if (!compact.ok) expect(compact.error.code).toBe(UNSUPPORTED_CAPABILITY_CODE);
    // steer/follow_up/abort on an idle session: rejected BEFORE acceptance with the stable code.
    for (const cmd of [
      { type: "steer", prompt: { text: "x" } },
      { type: "follow_up", prompt: { text: "x" } },
      { type: "abort" },
    ] as const) {
      const r = await control.dispatch("sD", cmd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(NO_ACTIVE_RUN_CODE);
    }
    const caps = control.capabilities();
    expect(caps.steering).toBe(true);
    expect(caps.followUp).toBe(true);
    expect(caps.manualCompaction).toBe(false);
  });
});

/** A tool whose execution blocks until the test releases it — the deterministic mid-run window. */
function makeGate() {
  let release: () => void = () => {};
  const opened = new Promise<void>((r) => {
    release = r;
  });
  const tool: AgentTool = {
    name: "gate",
    label: "Gate",
    description: "Blocks until released",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      await Promise.race([
        opened,
        new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);
      return { content: [{ type: "text", text: "gate opened" }], details: {} };
    },
  };
  return { tool, release };
}

/** Agent + control with the gate tool mounted — for mid-run dispatch tests. */
function makeGated(responses: FauxResponseStep[]) {
  const { faux, models } = makeFaux();
  faux.setResponses(responses);
  const sessions = inMemorySessionStore();
  const { control, observer } = createPiSessionControl({ sessions });
  const gate = makeGate();
  const agent = createPiAgentFromHarness({
    observer,
    harnessFactory: piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      tools: [gate.tool],
      systemPrompt: "test",
    }),
  });
  return { agent, control, gate };
}

/** Drive invoke in the background; resolve with all events once settled. */
function drive(
  agent: { invoke: (s: { session: string }, p: { text: string }) => AsyncIterable<AgentEvent> },
  session: string,
) {
  return (async () => {
    const out: AgentEvent[] = [];
    for await (const e of agent.invoke({ session }, { text: "go" })) out.push(e);
    return out;
  })();
}

/** Wait until the control plane reports an active run for the session. */
async function waitForRunning(control: ReturnType<typeof makeGated>["control"], session: string) {
  for (let i = 0; i < 200; i++) {
    const s = await control.state(session);
    if (s.status === "running" && s.activeRunId) return s.activeRunId;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("run never became active");
}

/** Wait until the given tool is executing (its started event was observed). */
async function waitForToolStarted(control: ReturnType<typeof makeGated>["control"], session: string) {
  for await (const ev of control.events(session)) {
    if (ev.type === "tool_started") return;
    if (ev.type === "run_settled") throw new Error("run settled before the tool started");
  }
}

describe("session control (Phase 2a): run modulation", () => {
  it("steer joins the active run: accepted with its runId, delivered before the next model call, settle window spans it", async () => {
    const { agent, control, gate } = makeGated([
      fauxAssistantMessage(fauxToolCall("gate", {}, { id: "g1" })),
      fauxAssistantMessage("steered answer"),
    ]);
    const invoked = drive(agent, "s2a");
    const toolRunning = waitForToolStarted(control, "s2a");
    const runId = await waitForRunning(control, "s2a");
    await toolRunning;

    const result = await control.dispatch("s2a", { type: "steer", prompt: { text: "actually, do it differently" } });
    expect(result).toEqual({ ok: true, runId });
    // Queue visibility while the steer is pending (the gate still holds the run). Poll: the
    // contract says "queued", not "queue_update delivered synchronously before dispatch resolves".
    for (let i = 0; i < 200 && (await control.state("s2a")).pending.steering !== 1; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await control.state("s2a")).pending.steering).toBe(1);

    gate.release();
    const events = await invoked;
    // Settle window: the steered continuation's text arrives in the SAME invoke stream.
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toContain("steered answer");
    expect(events.at(-1)).toEqual({ type: "completed" });
    // After settle the queue state is gone with the run.
    const after = await control.state("s2a");
    expect(after.status).toBe("idle");
    expect(after.pending).toEqual({ steering: 0, followUp: 0 });
  });

  it("follow_up continues the run after it would otherwise stop; queue_changed is observable", async () => {
    const { agent, control, gate } = makeGated([
      fauxAssistantMessage(fauxToolCall("gate", {}, { id: "g1" })),
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("follow-up answer"),
    ]);
    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("s2b")) {
        seen.push(ev);
        if (ev.type === "run_settled") break;
      }
    })();
    const invoked = drive(agent, "s2b");
    await waitForRunning(control, "s2b");
    // Wait for the tool to be executing before queueing the follow-up.
    while (!seen.some((e) => e.type === "tool_started")) await new Promise((r) => setTimeout(r, 5));

    const result = await control.dispatch("s2b", { type: "follow_up", prompt: { text: "and then summarize" } });
    expect(result.ok).toBe(true);
    gate.release();
    const events = await invoked;
    await watching;

    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toContain("first answer");
    expect(text).toContain("follow-up answer"); // the settle window spanned the continuation
    expect(seen.some((e) => e.type === "queue_changed")).toBe(true);
    expect(seen.filter((e) => e.type === "run_settled")).toHaveLength(1); // still exactly one
  });

  it("stale controls are rejected after settlement — never a silent acceptance", async () => {
    const { faux, models } = makeFaux();
    faux.setResponses([fauxAssistantMessage("done")]);
    let captured: import("../src/engines/pi/invoke.ts").RunControls | undefined;
    const agent = createPiAgentFromHarness({
      observer: (_s, ev, run) => {
        if (ev.type === "run_started") captured = run;
      },
      harnessFactory: piHarnessFactory({
        sessions: inMemorySessionStore(),
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        models,
        model: faux.getModel(),
        systemPrompt: "test",
      }),
    });
    await drain(agent.invoke({ session: "sStale" }, { text: "hi" })); // run fully settled
    expect(captured).toBeDefined();
    // A dispatch that grabbed the controls before settlement and calls after it must THROW —
    // pi's queue/abort calls would otherwise resolve silently against a discarded harness.
    await expect((captured as NonNullable<typeof captured>).steer({ text: "late" })).rejects.toThrow(/already settled/);
    await expect((captured as NonNullable<typeof captured>).abort()).rejects.toThrow(/already settled/);
  });

  it("a dispatch racing a failing harness build gets run_command_failed with the setup error", async () => {
    const sessions = inMemorySessionStore();
    const { control, observer } = createPiSessionControl({ sessions });
    let releaseFactory: () => void = () => {};
    const factoryGate = new Promise<void>((r) => {
      releaseFactory = r;
    });
    const agent = createPiAgentFromHarness({
      observer,
      harnessFactory: async () => {
        await factoryGate;
        throw new Error("boom: setup exploded");
      },
    });
    const invoked = drive(agent, "sSetup");
    await waitForRunning(control, "sSetup"); // run_started observed; harness still assembling
    const pending = control.dispatch("sSetup", { type: "steer", prompt: { text: "late" } });
    releaseFactory(); // → factory throws → gate rejects → the pending dispatch learns it
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RUN_COMMAND_FAILED_CODE);
      expect(result.error.message).toContain("boom");
    }
    const events = await invoked;
    expect(events.at(-1)).toMatchObject({ type: "failed" }); // the data plane failed visibly too
  });

  it("dispatch maps a refused run command to run_command_failed", async () => {
    const sessions = inMemorySessionStore();
    const { control, observer } = createPiSessionControl({ sessions });
    // Register a live run whose controls refuse — the observer seam is the public wiring point.
    observer(
      "sRefuse",
      { type: "run_started", timestamp: Date.now(), runId: "r1", data: {} },
      {
        steer: async () => {
          throw new Error("run already settled; the command cannot take effect");
        },
        followUp: async () => {},
        abort: async () => {},
      },
    );
    const result = await control.dispatch("sRefuse", { type: "steer", prompt: { text: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RUN_COMMAND_FAILED_CODE);
      expect(result.error.retryable).toBe(false); // as-is retry fails again — consult state() first
    }
  });

  it("abort stops the run: accepted, invoke terminal failed{code: aborted}, run_settled{aborted}", async () => {
    const { agent, control, gate } = makeGated([fauxAssistantMessage(fauxToolCall("gate", {}, { id: "g1" }))]);
    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("s2c")) {
        seen.push(ev);
        if (ev.type === "run_settled") break;
      }
    })();
    const invoked = drive(agent, "s2c");
    await waitForRunning(control, "s2c");
    while (!seen.some((e) => e.type === "tool_started")) await new Promise((r) => setTimeout(r, 5));

    const result = await control.dispatch("s2c", { type: "abort" });
    expect(result.ok).toBe(true);
    void gate; // never released — abort must cut through the blocked tool
    const events = await invoked;
    await watching;

    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ type: "failed", code: ABORTED_CODE, retryable: false });
    const settled = seen.find((e) => e.type === "run_settled");
    expect(settled?.data).toMatchObject({ status: "aborted" }); // error.message carries the stop detail
    // The session is reusable: back to idle, not poisoned.
    expect((await control.state("s2c")).status).toBe("idle");
  });
});
