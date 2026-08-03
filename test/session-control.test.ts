/**
 * Session control plane, Phase 1 (observation plane) conformance — docs/design/session-control.md:
 * projection fidelity (AgentEvent is a projection of the rich stream), ordering, run boundaries
 * (exactly one run_settled per run_started, incl. caller cancellation), reconnect (entries cursor +
 * state), read-only observation (no session creation), and acceptance-vs-outcome on dispatch.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type FauxResponseStep, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import { ABORTED_CODE, type AgentEvent } from "../src/agent.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { SUBSCRIBER_BUFFER_CAP, createPiSessionControl } from "../src/engines/pi/session-control.ts";
import { inMemorySessionStore } from "../src/engines/pi/sessions.ts";
import { createPiAgentFromDir } from "../src/engines/pi/open.ts";
import {
  BOUNDARY_COMMAND_FAILED_CODE,
  NOTHING_TO_COMPACT_CODE,
  INVALID_COMMAND_CODE,
  NO_ACTIVE_RUN_CODE,
  NO_SUCH_SESSION_CODE,
  RUN_COMMAND_FAILED_CODE,
  UNSUPPORTED_CAPABILITY_CODE,
  type SessionEntry,
  type SessionEvent,
} from "../src/session.ts";
import { SESSION_BUSY_CODE } from "../src/agent.ts";
import type { PiBoundaryWiring } from "../src/engines/pi/session-control.ts";
import { inProcessLease } from "../src/engines/pi/invoke.ts";
import type { PiSessionReader } from "../src/engines/pi/sessions.ts";
import { resolveHarnessOverrides } from "../src/engines/pi/harness.ts";
import { makeFaux } from "./faux.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

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
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      sessions,

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
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        sessions: inMemorySessionStore(),

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

  it("a skill that failed to load is absent from commands() and warned once", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "fa-sc-bad-"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(dir, "fastagent"), { recursive: true });
      await writeFile(
        join(dir, "fastagent", "fastagent.config.mjs"),
        `export default { model: "openai-codex/gpt-5.5" };\n`,
      );
      const opened = await createPiAgentFromDir(dir, { sessionControl: true });
      const control = opened.sessionControl as NonNullable<typeof opened.sessionControl>;
      // Broken AFTER boot — which is the case the read exists for: a finding already present at
      // startup was reported by the caller's boot report, and re-printing it is the spam the memo
      // prevents (test/report.test.ts pins that half).
      await mkdir(join(dir, "fastagent", "skills", "broken"), { recursive: true });
      await writeFile(join(dir, "fastagent", "skills", "broken", "SKILL.md"), `no frontmatter here\n`);
      // The broken file cannot be listed — so this read is the only place that can say it exists.
      expect(await control.commands()).toEqual([]);
      expect(warn.mock.calls.flat().join(" ")).toContain("broken");
      // … once: a composer opening twice must not spam a finding that has not changed.
      warn.mockClear();
      await control.commands();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("workspace opener wires the hub itself (sessionControl: true) — the seam is executable", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "fa-sc-ws-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "fastagent"));
      await writeFile(
        join(dir, "fastagent", "fastagent.config.mjs"),
        `export default { model: "openai-codex/gpt-5.5" };\n`,
      );
      const opened = await createPiAgentFromDir(dir, { sessionControl: true });
      expect(opened.sessionControl).toBeDefined();
      const control = opened.sessionControl as NonNullable<typeof opened.sessionControl>;
      // The control is live over this workspace's (jsonl) store: read-only observation works
      // without a single model call, and an unknown session stays uncreated.
      expect(await control.state("ghost")).toEqual({ status: "idle", pending: { steering: 0, followUp: 0 } });
      expect(await control.entries("ghost")).toEqual({ entries: [] });
      expect(await opened.sessions.openIfExists("ghost")).toBeUndefined();
      // Not requested → not built.
      const plain = await createPiAgentFromDir(dir, {});
      expect(plain.sessionControl).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("commands() re-reads the definition per call: added and removed skills, collisions first-wins", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "fa-sc-cmd-"));
    try {
      await mkdir(join(dir, "fastagent"));
      await writeFile(
        join(dir, "fastagent", "fastagent.config.mjs"),
        `export default { model: "openai-codex/gpt-5.5" };\n`,
      );
      const opened = await createPiAgentFromDir(dir, { sessionControl: true });
      const control = opened.sessionControl as NonNullable<typeof opened.sessionControl>;

      // Empty is a complete answer …
      expect(await control.commands()).toEqual([]);
      // … and the read is LIVE, like the definition itself: a skill written while serving is
      // invocable on the next turn, so it must be listable NOW — a boot snapshot would advertise a
      // command set the running agent has already left behind.
      await mkdir(join(dir, "fastagent", "skills", "triage"), { recursive: true });
      await writeFile(
        join(dir, "fastagent", "skills", "triage", "SKILL.md"),
        `---\nname: triage\ndescription: Sort an inbox\n---\n\nDo the thing.\n`,
      );
      expect(await control.commands()).toEqual([{ name: "triage", description: "Sort an inbox", source: "skill" }]);
      // The RESOLVED set, which is the reason this read exists: a same-name collision is decided
      // first-wins at assembly, and a client reading the directory would list the name twice.
      await mkdir(join(dir, "fastagent", "skills", "triage-copy"), { recursive: true });
      await writeFile(
        join(dir, "fastagent", "skills", "triage-copy", "SKILL.md"),
        `---\nname: triage\ndescription: A second claim on the same name\n---\n\nDo it differently.\n`,
      );
      expect(await control.commands()).toEqual([{ name: "triage", description: "Sort an inbox", source: "skill" }]);
      // Live in BOTH directions — a cached read would only ever grow the list.
      await rm(join(dir, "fastagent", "skills"), { recursive: true, force: true });
      expect(await control.commands()).toEqual([]);
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
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      sessions,

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

  it("toTerminal attributes pi's own stopReason 'aborted' without any control-plane intent", async () => {
    const { toTerminal } = await import("../src/engines/pi/invoke.ts");
    const terminal = toTerminal({
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "faux",
      model: "faux",
      stopReason: "aborted",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 0,
    } as never);
    expect(terminal).toMatchObject({ type: "failed", code: ABORTED_CODE, retryable: false });
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
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        sessions: inMemorySessionStore(),

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

  it("a subscriber far behind is closed instead of buffering without bound", async () => {
    const { control, observer } = createPiSessionControl({ sessions: inMemorySessionStore() });
    const iterator = control.events("sSlow")[Symbol.asyncIterator]();
    const first = iterator.next(); // registration is synchronous at next() entry; the pull now stalls
    observer("sSlow", { type: "run_started", timestamp: 0, runId: "r", data: {} });
    await first; // the first event flows; the consumer never pulls again after this
    for (let i = 0; i < SUBSCRIBER_BUFFER_CAP + 1; i++) {
      observer("sSlow", { type: "message_delta", timestamp: i, runId: "r", data: { channel: "text", delta: "x" } });
    }
    // The stream was closed by the cap: draining reaches done instead of 10k+ buffered events.
    let drained = 0;
    for (;;) {
      const r = await iterator.next();
      if (r.done) break;
      drained++;
      if (drained > 20_000) throw new Error("cap did not close the stream");
    }
    expect(drained).toBeLessThanOrEqual(SUBSCRIBER_BUFFER_CAP);
    // Released, not wedged: a FRESH subscription on the same session works and receives new events.
    const fresh = control.events("sSlow")[Symbol.asyncIterator]();
    const next = fresh.next();
    observer("sSlow", { type: "run_settled", timestamp: 1, runId: "r", data: { status: "completed" } });
    expect(((await next) as IteratorYieldResult<SessionEvent>).value.type).toBe("run_settled");
    await fresh.return?.(undefined);
  }, 10_000);

  it("every iteration of one events iterable is a FRESH subscription (isomorphic with remote)", async () => {
    const { control, observer } = createPiSessionControl({ sessions: inMemorySessionStore() });
    const iterable = control.events("sReIter");
    // First iteration: consume one event, then walk away.
    const first = iterable[Symbol.asyncIterator]();
    const p1 = first.next();
    observer("sReIter", { type: "run_started", timestamp: 0, runId: "r1", data: {} });
    expect(((await p1) as IteratorYieldResult<SessionEvent>).value.type).toBe("run_started");
    await first.return?.(undefined);
    // Second iteration of the SAME iterable: a fresh subscription, not a poisoned/shared one.
    const second = iterable[Symbol.asyncIterator]();
    const p2 = second.next();
    observer("sReIter", { type: "run_settled", timestamp: 1, runId: "r1", data: { status: "completed" } });
    expect(((await p2) as IteratorYieldResult<SessionEvent>).value.type).toBe("run_settled");
    await second.return?.(undefined);
  }, 5_000);

  it("concurrent next() calls on one events subscription both settle", async () => {
    const { control, observer } = createPiSessionControl({ sessions: inMemorySessionStore() });
    const iterator = control.events("sConc")[Symbol.asyncIterator]();
    const n1 = iterator.next(); // registers synchronously, then awaits
    const n2 = iterator.next(); // a second pending pull — must not overwrite the first's waiter
    observer("sConc", { type: "run_started", timestamp: 0, runId: "rA", data: {} });
    observer("sConc", { type: "run_settled", timestamp: 1, runId: "rA", data: { status: "completed" } });
    const [r1, r2] = await Promise.all([n1, n2]); // the old bug: one of these hung forever
    const types = [r1, r2].map((r) => (r.done ? "done" : r.value.type)).sort();
    expect(types).toEqual(["run_settled", "run_started"].sort());
    await iterator.return?.(undefined);
  }, 5_000);

  it("the hub's own last line: an unknown command type (in-process misuse) answers invalid_command", async () => {
    // The transport's parseWireCommand intercepts wire input first; this default branch is the
    // LAST line for in-process callers casting past the union — it must answer, never undefined.
    const { control } = makeObserved([]);
    const result = await control.dispatch("sD", { type: "make_coffee" } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(INVALID_COMMAND_CODE);
  });

  it("an observation-only run (no controls) rejects with unsupported_capability, not a run code", async () => {
    const sessions = inMemorySessionStore();
    const { control, observer } = createPiSessionControl({ sessions });
    // run_started without controls — the observer seam permits observation-only registration.
    observer("sObs", { type: "run_started", timestamp: Date.now(), runId: "r1", data: {} });
    expect((await control.state("sObs")).status).toBe("running"); // state truthfully reports the run
    const result = await control.dispatch("sObs", { type: "steer", prompt: { text: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Capability problem (permanent for this wiring) — NOT no_active_run (would poll forever)
      // and NOT run_command_failed (transient).
      expect(result.error.code).toBe(UNSUPPORTED_CAPABILITY_CODE);
    }
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
    // Intent-attributed (the faux provider surfaces a plain error, not stopReason "aborted" — the
    // in-flight abort classifies it), and NON-LOSSY: what actually stopped the run stays readable.
    const settledData = settled?.data as { status: string; error?: { message: string } };
    expect(settledData).toMatchObject({ status: "aborted" });
    expect(settledData.error?.message).toBeTruthy();
    // The session is reusable: back to idle, not poisoned.
    expect((await control.state("s2c")).status).toBe("idle");
  });
});

/** Agent + control with full boundary wiring — the workspace shape, assembled by hand. The model is
 *  REASONING-capable: thinking levels are answered per model, so the default faux (`reasoning:
 *  false`) supports only "off". */
function makeBoundary(responses: FauxResponseStep[], tools: AgentTool[] = []) {
  const { faux, models } = makeFaux({ models: [{ id: "faux-thinker", reasoning: true }] });
  faux.setResponses(responses);
  const sessions = inMemorySessionStore();
  const lease = inProcessLease();
  const factory = piHarnessFactory({
    env: new NodeExecutionEnv({ cwd: process.cwd() }),
    sessions,

    models,
    model: faux.getModel(),
    tools,
    systemPrompt: "test",
  });
  const boundary: PiBoundaryWiring = {
    lease,
    models,
    harnessFactory: factory,
    defaults: { model: faux.getModel(), thinkingLevel: "medium" },
  };
  const { control, observer } = createPiSessionControl({ sessions, boundary: () => boundary });
  const agent = createPiAgentFromHarness({ observer, lease, harnessFactory: factory });
  const spec = `${faux.getModel().provider}/${faux.getModel().id}`;
  return { agent, control, sessions, spec, models };
}

describe("session control (Phase 2b): boundary mutations", () => {
  it("capabilities carry only what is SESSIONLESS: the registry has a list, thinking levels do not", async () => {
    const { control, sessions, spec } = makeBoundary([]);
    const caps = control.capabilities();
    expect(caps.manualCompaction).toBe(true);
    expect(caps.modelSelection ? caps.modelSelection.allowedModels : []).toContain(spec); // deployment fact
    expect(caps.thinkingLevel).toBe(true); // per-session set rides state()
    await sessions.openOrCreate("sCaps");
    expect((await control.state("sCaps")).availableThinkingLevels).toContain("high");
  });

  it("thinking levels are answered by the MODEL: a non-reasoning model offers only off, and set_thinking rejects the rest", async () => {
    const { faux, models } = makeFaux(); // default faux: reasoning false
    const sessions = inMemorySessionStore();
    const lease = inProcessLease();
    const factory = piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      tools: [],
      systemPrompt: "test",
    });
    const boundary: PiBoundaryWiring = {
      lease,
      models,
      harnessFactory: factory,
      defaults: { model: faux.getModel(), thinkingLevel: "medium" },
    };
    const { control } = createPiSessionControl({ sessions, boundary: () => boundary });
    expect(control.capabilities().thinkingLevel).toBe(true); // servable — WHICH levels is per-session
    await sessions.openOrCreate("sNR");
    expect((await control.state("sNR")).availableThinkingLevels).toEqual(["off"]);
    // The lie this replaces: ok: true, a durable entry, and no effect on the run.
    const rejected = await control.dispatch("sNR", { type: "set_thinking", level: "high" });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe(INVALID_COMMAND_CODE);
    expect((await control.entries("sNR")).entries.map((e) => e.kind)).not.toContain("thinking_level_change");
    expect(await control.dispatch("sNR", { type: "set_thinking", level: "off" })).toEqual({ ok: true });
  });

  it("a reasoning model still rejects a level it has no mapping for (xhigh/max need one)", async () => {
    const { control, sessions } = makeBoundary([]); // faux-thinker: reasoning, no thinkingLevelMap
    await sessions.openOrCreate("sMax");
    expect((await control.state("sMax")).availableThinkingLevels).not.toContain("max");
    const rejected = await control.dispatch("sMax", { type: "set_thinking", level: "max" });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe(INVALID_COMMAND_CODE);
  });

  it("after set_model the SESSION's model is the authority: capabilities stays sessionless, set_thinking does not", async () => {
    const { faux, models } = makeFaux({ models: [{ id: "thinker", reasoning: true }, { id: "plain" }] });
    const thinker = faux.getModel("thinker") as NonNullable<ReturnType<typeof faux.getModel>>;
    const plain = faux.getModel("plain") as NonNullable<ReturnType<typeof faux.getModel>>;
    const sessions = inMemorySessionStore();
    const lease = inProcessLease();
    const factory = piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: thinker,
      tools: [],
      systemPrompt: "test",
    });
    const boundary: PiBoundaryWiring = {
      lease,
      models,
      harnessFactory: factory,
      defaults: { model: thinker, thinkingLevel: "medium" },
    };
    const { control } = createPiSessionControl({ sessions, boundary: () => boundary });
    await sessions.openOrCreate("sAuth");
    expect(await control.dispatch("sAuth", { type: "set_model", model: `${plain.provider}/${plain.id}` })).toEqual({
      ok: true,
    });
    // state() moved WITH the session — the levels it offers are the new model's …
    const after = await control.state("sAuth");
    expect(after.model).toBe(`${plain.provider}/${plain.id}`);
    expect(after.availableThinkingLevels).toEqual(["off"]);
    // … and the dispatch rejects exactly what that list excludes: one authority, two surfaces.
    const rejected = await control.dispatch("sAuth", { type: "set_thinking", level: "high" });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe(INVALID_COMMAND_CODE);
  });

  it("set_model RE-RECORDS a level the new model cannot do, so state and the run never disagree", async () => {
    // The failure this closes: the client set `high`, `set_model` moved the session to a model that
    // cannot do it, and nothing said so — `state()` went on reporting `high` (it reports what was
    // recorded), the resolve clamped at run time, and the client saw neither. The boundary re-records
    // instead, so whatever is recorded is executable and the demotion arrives in the same event.
    const { faux, models } = makeFaux({ models: [{ id: "thinker", reasoning: true }, { id: "plain" }] });
    const thinker = faux.getModel("thinker") as NonNullable<ReturnType<typeof faux.getModel>>;
    const plain = faux.getModel("plain") as NonNullable<ReturnType<typeof faux.getModel>>;
    const sessions = inMemorySessionStore();
    const boundary: PiBoundaryWiring = {
      lease: inProcessLease(),
      models,
      harnessFactory: piHarnessFactory({
        sessions,
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        models,
        model: thinker,
        tools: [],
        systemPrompt: "test",
      }),
      defaults: { model: thinker, thinkingLevel: "medium" },
    };
    const { control } = createPiSessionControl({ sessions, boundary: () => boundary });
    await sessions.openOrCreate("sDemote");
    expect(await control.dispatch("sDemote", { type: "set_thinking", level: "high" })).toEqual({ ok: true });

    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("sDemote")) {
        seen.push(ev);
        if (ev.type === "state_changed") break;
      }
    })();
    expect(await control.dispatch("sDemote", { type: "set_model", model: `${plain.provider}/${plain.id}` })).toEqual({
      ok: true,
    });
    await watching;
    // ONE event, carrying both halves of what moved — not a model change the client must then
    // re-derive a level from.
    expect(seen.filter((e) => e.type === "state_changed")).toHaveLength(1);
    expect((seen.find((e) => e.type === "state_changed") as { data: unknown }).data).toEqual({
      model: `${plain.provider}/${plain.id}`,
      thinkingLevel: "off",
    });
    const state = await control.state("sDemote");
    expect(state.thinkingLevel).toBe("off"); // …and state agrees with what the run will do
    // A model that CAN do the recorded level is left alone: no spurious demotion, no second entry.
    await sessions.openOrCreate("sKeep");
    expect(await control.dispatch("sKeep", { type: "set_thinking", level: "high" })).toEqual({ ok: true });
    expect(await control.dispatch("sKeep", { type: "set_model", model: `${thinker.provider}/${thinker.id}` })).toEqual({
      ok: true,
    });
    expect((await control.state("sKeep")).thinkingLevel).toBe("high");
    expect((await control.entries("sKeep")).entries.filter((e) => e.kind === "thinking_level_change")).toHaveLength(1);
  });

  it("the resolve still clamps as a BACKSTOP — the case the boundary cannot see", () => {
    const { faux, models } = makeFaux({ models: [{ id: "thinker", reasoning: true }, { id: "plain" }] });
    const thinker = faux.getModel("thinker") as NonNullable<ReturnType<typeof faux.getModel>>;
    const plain = faux.getModel("plain") as NonNullable<ReturnType<typeof faux.getModel>>;
    // set_thinking(high) was admitted against the reasoning model; set_model then moved the session
    // to one that cannot do it. The resolve must not hand the run a level it will ignore.
    const out = resolveHarnessOverrides(
      [
        { type: "thinking_level_change", thinkingLevel: "high" },
        { type: "model_change", provider: plain.provider, modelId: plain.id },
      ],
      models,
      { model: thinker, thinkingLevel: "low" },
      "sSwap",
    );
    expect(out.model).toBe(plain);
    expect(out.thinkingLevel).toBe("off"); // clamped by the model, not left at a level the run ignores
  });

  it("one resolution answers all three surfaces — state, the dispatch gate, and execution", async () => {
    // state(), the set_thinking gate and the fresh harness all resolve through one function.
    const { faux, models } = makeFaux({ models: [{ id: "thinker", reasoning: true }, { id: "plain" }] });
    const thinker = faux.getModel("thinker") as NonNullable<ReturnType<typeof faux.getModel>>;
    const plain = faux.getModel("plain") as NonNullable<ReturnType<typeof faux.getModel>>;
    const sessions = inMemorySessionStore();
    const defaults = { model: thinker, thinkingLevel: "medium" as const };
    const boundary: PiBoundaryWiring = {
      lease: inProcessLease(),
      models,
      harnessFactory: piHarnessFactory({
        sessions,
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        models,
        model: thinker,
        tools: [],
        systemPrompt: "test",
      }),
      defaults,
    };
    const { control } = createPiSessionControl({ sessions, boundary: () => boundary });
    await sessions.openOrCreate("sOne");
    expect(await control.dispatch("sOne", { type: "set_thinking", level: "high" })).toEqual({ ok: true });
    expect(await control.dispatch("sOne", { type: "set_model", model: `${plain.provider}/${plain.id}` })).toEqual({
      ok: true,
    });

    const opened = await sessions.openIfExists("sOne");
    const entries = ((await opened?.getEntries()) ?? []) as Parameters<typeof resolveHarnessOverrides>[0];
    const state = await control.state("sOne");
    const executed = resolveHarnessOverrides(entries, models, defaults, "sOne");

    // The record keeps the PREFERENCE — nothing rewrote it …
    const { lastOverrideEntries } = await import("../src/engines/pi/session-settings.ts");
    expect(lastOverrideEntries(entries).thinkingLevel).toBe("high");
    // … while every surface agrees on what actually happens.
    expect(state.thinkingLevel).toBe("off");
    expect(executed.thinkingLevel).toBe("off");
    expect(state.availableThinkingLevels).toEqual(["off"]);
    expect(await control.dispatch("sOne", { type: "set_thinking", level: "high" })).toMatchObject({ ok: false });
    // Back to a capable model: the preference returns, unsent.
    expect(await control.dispatch("sOne", { type: "set_model", model: `${thinker.provider}/${thinker.id}` })).toEqual({
      ok: true,
    });
    expect((await control.state("sOne")).thinkingLevel).toBe("high");
  });

  it("the clamp we borrow resolves a GAP upward, not down", async () => {
    // A cost increase, not a conservative degrade — and invisible in a non-reasoning model's scale,
    // which is all the faux registry can express (FauxModelDefinition has no thinkingLevelMap). So it
    // is pinned against pi directly: an upstream change to the direction fails here.
    const { clampThinkingLevel, getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
    const gapped = {
      provider: "probe",
      id: "gapped",
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: null },
    } as unknown as Parameters<typeof clampThinkingLevel>[0];
    expect(getSupportedThinkingLevels(gapped)).toEqual(["off", "high"]);
    expect(clampThinkingLevel(gapped, "low")).toBe("high"); // UP, not down to "off"
    expect(clampThinkingLevel(gapped, "xhigh")).toBe("high"); // nothing above → the highest below
  });

  it("set_model / set_thinking append durable overrides and emit state_changed", async () => {
    const { agent, control, sessions, spec, models } = makeBoundary([fauxAssistantMessage("ok")]);
    await drain(agent.invoke({ session: "sB1" }, { text: "hi" })); // session exists
    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("sB1")) {
        seen.push(ev);
        if (seen.filter((e) => e.type === "state_changed").length === 2) break;
      }
    })();
    expect(await control.dispatch("sB1", { type: "set_model", model: spec })).toEqual({ ok: true });
    expect(await control.dispatch("sB1", { type: "set_thinking", level: "high" })).toEqual({ ok: true });
    await watching;
    // set_model reports both halves — a new model can change which level executes.
    expect(seen.map((e) => e.data)).toEqual([{ model: spec, thinkingLevel: "medium" }, { thinkingLevel: "high" }]);
    // Durable: the overrides live in the session record (open-set kinds on the entries plane).
    const kinds = (await control.entries("sB1")).entries.map((e) => e.kind);
    expect(kinds).toContain("model_change");
    expect(kinds).toContain("thinking_level_change");
    // And the fresh-harness resolve applies them: the recorded thinking level rides the next turn.
    const opened = await sessions.openIfExists("sB1");
    const resolved = resolveHarnessOverrides(
      ((await opened?.getEntries()) ?? []) as Parameters<typeof resolveHarnessOverrides>[0],
      models,
      { model: models.getProviders()[0]!.getModels()[0]!, thinkingLevel: "medium" },
      "sB1",
    );
    expect(resolved.thinkingLevel).toBe("high");
  });

  it("navigate moves the leaf, so the NEXT turn branches from the target", async () => {
    let thirdTurnContext = "";
    const { agent, control } = makeBoundary([
      fauxAssistantMessage("one"),
      fauxAssistantMessage("two"),
      (context) => {
        thirdTurnContext = JSON.stringify(context.messages);
        return fauxAssistantMessage("three");
      },
    ]);
    await drain(agent.invoke({ session: "sNav" }, { text: "first" }));
    await drain(agent.invoke({ session: "sNav" }, { text: "second" }));
    const before = (await control.entries("sNav")).entries;
    const target = before.find((e) => e.kind === "assistant") as SessionEntry;
    expect((await control.state("sNav")).leafEntryId).not.toBe(target.id);

    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("sNav")) {
        seen.push(ev);
        if (ev.type === "state_changed") break;
      }
    })();
    expect(await control.dispatch("sNav", { type: "navigate", targetId: target.id })).toEqual({ ok: true });
    await watching;
    // The settings ride along: a move can change which model/level the next turn runs on.
    expect(seen.at(-1)?.data).toMatchObject({ leafEntryId: target.id, thinkingLevel: "medium" });
    expect((await control.state("sNav")).leafEntryId).toBe(target.id);

    // The point of moving a leaf: the next turn hangs off the target, creating a sibling branch —
    // the second turn's records stay in the repository but leave the active path.
    await drain(agent.invoke({ session: "sNav" }, { text: "third" }));
    const after = (await control.entries("sNav")).entries;
    const byId = new Map(after.map((e) => [e.id, e]));
    const path: string[] = [];
    for (let id = (await control.state("sNav")).leafEntryId; id; id = byId.get(id)?.parentId) path.unshift(id);
    expect(path).toContain(target.id);
    expect(after.map((e) => e.id)).toEqual(expect.arrayContaining(before.map((e) => e.id))); // nothing deleted
    // Everything the old branch recorded past the target is off the active path now — still in the
    // repository, no longer what the next turn continues.
    const abandoned = before.slice(before.indexOf(target) + 1).map((e) => e.id);
    expect(abandoned.length).toBeGreaterThan(0);
    expect(path.filter((id) => abandoned.includes(id))).toEqual([]);
    // What the move is FOR: the model saw the branch it was moved to, not the one it left.
    expect(thirdTurnContext).toContain("first");
    expect(thirdTurnContext).toContain("third");
    expect(thirdTurnContext).not.toContain("second");
  });

  it("a setting recorded on a branch the session LEFT does not follow it back", async () => {
    // The silent consequence of a movable leaf: every last-wins read (state(), the fresh-harness
    // resolve, the activation walk) reads the journal, which still holds the abandoned branch.
    let ranWith: string | undefined;
    const { faux, models } = makeFaux({ models: [{ id: "default-model" }, { id: "other-model" }] });
    const dflt = faux.getModel("default-model") as NonNullable<ReturnType<typeof faux.getModel>>;
    const other = faux.getModel("other-model") as NonNullable<ReturnType<typeof faux.getModel>>;
    faux.setResponses([
      fauxAssistantMessage("one"),
      (_context, _options, _state, model) => {
        ranWith = model.id;
        return fauxAssistantMessage("two");
      },
    ]);
    const sessions = inMemorySessionStore();
    const lease = inProcessLease();
    const factory = piHarnessFactory({
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      sessions,
      models,
      model: dflt,
      tools: [],
      systemPrompt: "test",
    });
    const { control, observer } = createPiSessionControl({
      sessions,
      boundary: () => ({ lease, models, harnessFactory: factory, defaults: { model: dflt, thinkingLevel: "medium" } }),
    });
    const agent = createPiAgentFromHarness({ observer, lease, harnessFactory: factory });

    await drain(agent.invoke({ session: "sNavLeak" }, { text: "hi" }));
    const target = (await control.entries("sNavLeak")).entries.find((e) => e.kind === "user") as SessionEntry;
    const spec = `${other.provider}/${other.id}`;
    expect(await control.dispatch("sNavLeak", { type: "set_model", model: spec })).toEqual({ ok: true });
    expect((await control.state("sNavLeak")).model).toBe(spec);
    // Move back to a point BEFORE the override was recorded: it is off the active path now.
    const moved = (async () => {
      for await (const ev of control.events("sNavLeak")) if (ev.type === "state_changed") return ev;
    })();
    expect(await control.dispatch("sNavLeak", { type: "navigate", targetId: target.id })).toEqual({ ok: true });
    // The event says so too — a client tracking the model from the stream must not show the one the
    // next turn will not use.
    expect((await moved)?.data).toMatchObject({ leafEntryId: target.id, model: `${dflt.provider}/${dflt.id}` });
    expect((await control.state("sNavLeak")).model).toBe(`${dflt.provider}/${dflt.id}`); // assembly default
    await drain(agent.invoke({ session: "sNavLeak" }, { text: "again" }));
    expect(ranWith).toBe(dflt.id); // and the RUN agrees with what state() reports
  });

  it("navigating onto an assistant whose tool result is now off-path leaves a transcript the next turn can run", async () => {
    // A move writes no message, but it can EXPOSE a dangling tool_use pair — the state
    // reconcileInterruptedToolCalls exists for. It repairs AT THE LEAF, which is exactly where a
    // move puts the gap, so the next invoke runs instead of handing the provider a rejected pair.
    const { agent, control } = makeBoundary(
      [
        fauxAssistantMessage(fauxToolCall("echo", { value: "hi" }, { id: "e1" })),
        fauxAssistantMessage("done"),
        fauxAssistantMessage("after the move"),
      ],
      [echoTool],
    );
    await drain(agent.invoke({ session: "sNavDangle" }, { text: "call it" }));
    const callEntry = (await control.entries("sNavDangle")).entries.find(
      (e) => e.kind === "assistant" && (e.data as { toolCalls?: unknown[] }).toolCalls,
    ) as SessionEntry;
    expect(await control.dispatch("sNavDangle", { type: "navigate", targetId: callEntry.id })).toEqual({ ok: true });
    const events = await drain(agent.invoke({ session: "sNavDangle" }, { text: "continue" }));
    // The repair itself, not just a green run: the new branch carries a synthetic result for the
    // call whose real one is off-path — without it a real provider rejects the transcript.
    const path = (await control.entries("sNavDangle")).entries;
    const repaired = path.filter(
      (e) => e.kind === "tool" && (e.data as { toolCallId?: string; isError?: boolean }).toolCallId === "e1",
    );
    expect(repaired.some((e) => (e.data as { isError?: boolean }).isError)).toBe(true);
    expect(events.some((e) => e.type === "failed")).toBe(false);
    expect(events.at(-1)?.type).toBe("completed");
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toContain("after the move");
  });

  it("a move to where the leaf already is is accepted and writes nothing", async () => {
    // pi journals a move as a `leaf` record, so an idempotent re-dispatch (a client retry, a UI
    // firing on every selection) would otherwise grow the session by records no plane publishes.
    const { agent, control, sessions } = makeBoundary([fauxAssistantMessage("ok")]);
    await drain(agent.invoke({ session: "sNavNoop" }, { text: "hi" }));
    const leaf = (await control.state("sNavNoop")).leafEntryId as string;
    const size = async () => ((await (await sessions.openIfExists("sNavNoop"))?.getEntries()) ?? []).length;
    const before = await size();
    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("sNavNoop")) {
        seen.push(ev);
        if (ev.type === "state_changed") break;
      }
    })();
    expect(await control.dispatch("sNavNoop", { type: "navigate", targetId: leaf })).toEqual({ ok: true });
    await watching;
    // The event still travels: it reports the resulting POSITION, not that a record was written —
    // a concurrent client whose dispatch lost the race must not have to poll to learn where it is.
    expect(seen.at(-1)?.data).toMatchObject({ leafEntryId: leaf });
    expect(await size()).toBe(before);
    expect((await control.state("sNavNoop")).leafEntryId).toBe(leaf);
  });

  it("navigate rejects an entry that is not in the session, and a session that does not exist", async () => {
    const { agent, control } = makeBoundary([fauxAssistantMessage("ok")]);
    expect(control.capabilities().navigate).toBe(true);
    await drain(agent.invoke({ session: "sNavBad" }, { text: "hi" }));
    const leafBefore = (await control.state("sNavBad")).leafEntryId;
    const unknownEntry = await control.dispatch("sNavBad", { type: "navigate", targetId: "nope" });
    expect(unknownEntry.ok).toBe(false);
    if (!unknownEntry.ok) expect(unknownEntry.error.code).toBe(INVALID_COMMAND_CODE);
    expect((await control.state("sNavBad")).leafEntryId).toBe(leafBefore); // rejected before acceptance
    const unknownSession = await control.dispatch("sGhost", { type: "navigate", targetId: "x" });
    expect(unknownSession.ok).toBe(false);
    if (!unknownSession.ok) expect(unknownSession.error.code).toBe(NO_SUCH_SESSION_CODE);
  });

  it("the navigable set is every published entry EXCEPT the move bookkeeping a navigate itself writes", async () => {
    const { agent, control, sessions, spec } = makeBoundary([fauxAssistantMessage("ok")]);
    await drain(agent.invoke({ session: "sNavKinds" }, { text: "hi" }));
    expect(await control.dispatch("sNavKinds", { type: "set_model", model: spec })).toEqual({ ok: true });
    const entries = (await control.entries("sNavKinds")).entries;
    const modelChange = entries.find((e) => e.kind === "model_change");
    const user = entries.find((e) => e.kind === "user") as SessionEntry;
    // Move away, then back onto the boundary record: it is a legitimate target — the engine itself
    // leaves the leaf sitting on one after every set_model.
    expect(await control.dispatch("sNavKinds", { type: "navigate", targetId: user.id })).toEqual({ ok: true });
    expect(await control.dispatch("sNavKinds", { type: "navigate", targetId: modelChange!.id })).toEqual({ ok: true });
    // Those moves left `leaf` records behind. Pointing the branch head at one would put the leaf on
    // a record whose parentId is the OLD leaf — on no conversation path at all — and entries() does
    // not publish them: the client's rule is "anything published is navigable".
    const raw = (await (await sessions.openIfExists("sNavKinds"))?.getEntries()) ?? [];
    const leafRecord = raw.find((e) => e.type === "leaf");
    expect(leafRecord).toBeDefined();
    expect((await control.entries("sNavKinds")).entries.map((e) => e.id)).not.toContain(leafRecord?.id);
    const rejected = await control.dispatch("sNavKinds", { type: "navigate", targetId: leafRecord!.id });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe(INVALID_COMMAND_CODE);
    expect((await control.state("sNavKinds")).leafEntryId).toBe(modelChange!.id);
  });

  it("navigate takes the run lease: mid-run it is session_busy, and the live branch stays put", async () => {
    // The stated reason navigate is gated on the boundary wiring at all: a leaf moved under a live
    // run would hang that run's next entry off a stale branch.
    const { faux, models } = makeFaux();
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage(fauxToolCall("gate", {}, { id: "g1" }))]);
    const sessions = inMemorySessionStore();
    const lease = inProcessLease();
    const gate = makeGate();
    const factory = piHarnessFactory({
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      sessions,
      models,
      model: faux.getModel(),
      tools: [gate.tool],
      systemPrompt: "test",
    });
    const { control, observer } = createPiSessionControl({
      sessions,
      boundary: () => ({
        lease,
        models,
        harnessFactory: factory,
        defaults: { model: faux.getModel(), thinkingLevel: "medium" },
      }),
    });
    const agent = createPiAgentFromHarness({ observer, lease, harnessFactory: factory });
    await drain(agent.invoke({ session: "sNavBusy" }, { text: "hi" })); // a settled turn to aim at
    const target = (await control.entries("sNavBusy")).entries.find((e) => e.kind === "user") as SessionEntry;
    const leafBefore = (await control.state("sNavBusy")).leafEntryId;

    const invoked = drive(agent, "sNavBusy");
    await waitForRunning(control, "sNavBusy");
    const busy = await control.dispatch("sNavBusy", { type: "navigate", targetId: target.id });
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.error.code).toBe(SESSION_BUSY_CODE);
    expect((await control.state("sNavBusy")).leafEntryId).toBe(leafBefore); // the run's branch untouched
    gate.release();
    await invoked;
    expect(await control.dispatch("sNavBusy", { type: "navigate", targetId: target.id })).toEqual({ ok: true });
  });

  it("a compaction bounds the model context, not the settings history", async () => {
    // The active-path walk is not bounded by the compaction the way the CONTEXT read is: an
    // override recorded before one is a preference, and it still governs the session after it.
    const { agent, control } = makeBoundary([
      fauxAssistantMessage("a long answer worth compacting"),
      fauxAssistantMessage("another long answer"),
      fauxAssistantMessage("summary of the conversation"),
    ]);
    await drain(agent.invoke({ session: "sNavCompact" }, { text: "tell me things" }));
    expect(await control.dispatch("sNavCompact", { type: "set_thinking", level: "high" })).toEqual({ ok: true });
    await drain(agent.invoke({ session: "sNavCompact" }, { text: "more things" }));
    const finished = (async () => {
      for await (const ev of control.events("sNavCompact")) if (ev.type === "compaction_finished") return ev;
    })();
    expect(await control.dispatch("sNavCompact", { type: "compact" })).toEqual({ ok: true });
    expect((await finished)?.data).toMatchObject({ summary: expect.any(String) });
    expect((await control.entries("sNavCompact")).entries.map((e) => e.kind)).toContain("compaction");
    expect((await control.state("sNavCompact")).thinkingLevel).toBe("high");
  });

  it("a gap above the leaf leaves the settings absent; observation stays total, dispatch carries the code", async () => {
    // OBSERVATION IS TOTAL: an unreadable chain must not turn a read into a rejection with no
    // error-code channel to explain itself. The pair is simply absent (a control-less deployment
    // answers the same shape), and the fault surfaces where codes exist — dispatch. A corrupt
    // journal cannot be produced through the append path, so it is injected.
    const { models } = makeFaux();
    const brokenEntries = [
      { id: "leaf", parentId: "pruned", type: "message", timestamp: new Date().toISOString(), message: {} },
    ];
    const broken = {
      getEntries: async () => brokenEntries,
      getLeafId: async () => "leaf",
      getEntry: async (id: string) => brokenEntries.find((e) => e.id === id),
    } as unknown as Awaited<ReturnType<PiSessionReader["openIfExists"]>>;
    const { control } = createPiSessionControl({
      sessions: { openIfExists: async () => broken },
      boundary: () => ({
        lease: inProcessLease(),
        models,
        harnessFactory: (() => {
          throw new Error("unused");
        }) as never,
        defaults: { model: models.getProviders()[0]!.getModels()[0]!, thinkingLevel: "medium" },
      }),
    });
    const state = await control.state("sBroken");
    expect(state.status).toBe("idle");
    expect(state.leafEntryId).toBe("leaf");
    expect(state.model).toBeUndefined(); // unreadable, not silently defaulted
    expect(state.thinkingLevel).toBeUndefined();
    const entries = await control.entries("sBroken");
    expect(entries.entries.map((e) => e.id)).toEqual(["leaf"]);
    expect(entries.leafEntryId).toBe("leaf");
    // dispatch NEVER rejects, whatever the chain does: the transport promises a SessionResult.
    const rejected = await control.dispatch("sBroken", { type: "set_thinking", level: "high" });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe(BOUNDARY_COMMAND_FAILED_CODE);
  });

  it("a move whose new path is unreadable still reports the position it reached", async () => {
    // The durable write happened; reporting it as boundary_command_failed would be the one lie the
    // acceptance contract forbids. The settings are simply absent from the event.
    const { models } = makeFaux();
    let leafId = "b";
    const entries = [
      { id: "a", parentId: "pruned", type: "message", timestamp: new Date().toISOString(), message: {} },
      { id: "b", type: "message", timestamp: new Date().toISOString(), message: {} },
    ];
    const broken = {
      getEntries: async () => entries,
      getLeafId: async () => leafId,
      getEntry: async (id: string) => entries.find((e) => e.id === id),
      moveTo: async (id: string) => {
        leafId = id;
      },
    } as unknown as Awaited<ReturnType<PiSessionReader["openIfExists"]>>;
    const seen: SessionEvent[] = [];
    const { control } = createPiSessionControl({
      sessions: { openIfExists: async () => broken },
      boundary: () => ({
        lease: inProcessLease(),
        models,
        harnessFactory: (() => {
          throw new Error("unused");
        }) as never,
        defaults: { model: models.getProviders()[0]!.getModels()[0]!, thinkingLevel: "medium" },
      }),
      tap: (_session, event) => seen.push(event),
    });
    expect(await control.dispatch("sBrokenMove", { type: "navigate", targetId: "a" })).toEqual({ ok: true });
    expect(leafId).toBe("a"); // the move is durable …
    expect(seen.at(-1)?.data).toEqual({ leafEntryId: "a" }); // … and reported, settings absent
  });

  it("navigate without boundary wiring is gated off, not silently linear", async () => {
    const { control } = makeObserved([]);
    expect(control.capabilities().navigate).toBe(false);
    const rejected = await control.dispatch("sNavCap", { type: "navigate", targetId: "x" });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe(UNSUPPORTED_CAPABILITY_CODE);
  });

  it("resolveHarnessOverrides: a known recorded model override wins over the default", () => {
    const { faux, models } = makeFaux({ models: [{ id: "faux-a" }, { id: "faux-b" }] });
    const fallback = {
      model: faux.getModel("faux-a") as NonNullable<ReturnType<typeof faux.getModel>>,
      thinkingLevel: "medium" as const,
    };
    const recorded = faux.getModel("faux-b") as NonNullable<ReturnType<typeof faux.getModel>>;
    const out = resolveHarnessOverrides(
      [{ type: "model_change", provider: recorded.provider, modelId: recorded.id }],
      models,
      fallback,
      "sRK",
    );
    expect(out.model).toBe(recorded); // the session override rides the fresh harness
    expect(out.model).not.toBe(fallback.model);
  });

  it("resolveHarnessOverrides: last entry wins; unknown recorded model falls back with the default", () => {
    const { faux, models } = makeFaux({ models: [{ id: "faux-thinker", reasoning: true }] });
    const fallback = { model: faux.getModel(), thinkingLevel: "medium" as const };
    // Unknown model → fallback (deployment registry changed); known thinking level applies.
    const out = resolveHarnessOverrides(
      [
        { type: "model_change", provider: "gone", modelId: "nope" },
        { type: "thinking_level_change", thinkingLevel: "low" },
      ],
      models,
      fallback,
      "sR",
    );
    expect(out.model).toBe(fallback.model);
    expect(out.thinkingLevel).toBe("low");
    // Unknown thinking level → fallback.
    const bad = resolveHarnessOverrides(
      [{ type: "thinking_level_change", thinkingLevel: "ultra" }],
      models,
      fallback,
      "sR2",
    );
    expect(bad.thinkingLevel).toBe("medium");
  });

  it("a malformed override record reads as ABSENT on both surfaces — never skipped over", async () => {
    const { faux, models } = makeFaux({ models: [{ id: "faux-a" }, { id: "faux-b" }] });
    const fallback = {
      model: faux.getModel("faux-a") as NonNullable<ReturnType<typeof faux.getModel>>,
      thinkingLevel: "medium" as const,
    };
    const entries = [
      { type: "model_change", provider: faux.provider.id, modelId: "faux-b" }, // an earlier, VALID override
      { type: "model_change" }, // the LAST record is malformed
    ];
    // Execution surface: malformed = absent → the default, NOT the earlier valid record.
    const resolved = resolveHarnessOverrides(entries, models, fallback, "sMal");
    expect(resolved.model).toBe(fallback.model);
    // Fact surface agrees: no override reported.
    const { lastOverrideEntries } = await import("../src/engines/pi/session-settings.ts");
    expect(lastOverrideEntries(entries).model).toBeUndefined();
  });

  it("set_model rejects an unknown spec before acceptance (invalid_command)", async () => {
    const { control } = makeBoundary([]);
    const result = await control.dispatch("sB2", { type: "set_model", model: "ghost/model" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(INVALID_COMMAND_CODE);
    const bad = await control.dispatch("sB2", { type: "set_thinking", level: "ultra" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe(INVALID_COMMAND_CODE);
  });

  it("boundary mutations are rejected session_busy while a run holds the lease", async () => {
    const { faux, models } = makeFaux();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("gate", {}, { id: "g1" }))]);
    const sessions = inMemorySessionStore();
    const lease = inProcessLease();
    const gate = makeGate();
    const factory = piHarnessFactory({
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      sessions,

      models,
      model: faux.getModel(),
      tools: [gate.tool],
      systemPrompt: "test",
    });
    const boundary: PiBoundaryWiring = {
      lease,
      models,
      harnessFactory: factory,
      defaults: { model: faux.getModel(), thinkingLevel: "medium" },
    };
    const { control, observer } = createPiSessionControl({ sessions, boundary: () => boundary });
    const agent = createPiAgentFromHarness({ observer, lease, harnessFactory: factory });
    const spec = `${faux.getModel().provider}/${faux.getModel().id}`;

    const invoked = drive(agent, "sB3");
    await waitForRunning(control, "sB3");
    const busy = await control.dispatch("sB3", { type: "set_model", model: spec });
    expect(busy.ok).toBe(false);
    if (!busy.ok) {
      expect(busy.error.code).toBe(SESSION_BUSY_CODE);
      expect(busy.error.retryable).toBe(true); // retry AT IDLE succeeds as-is
    }
    gate.release();
    await invoked;
    expect(await control.dispatch("sB3", { type: "set_model", model: spec })).toEqual({ ok: true });
  });

  it("compact is accept-fast: ok on admission, outcome via compaction_finished, then lease free", async () => {
    const { agent, control } = makeBoundary([
      fauxAssistantMessage("a long answer worth compacting"),
      fauxAssistantMessage("summary of the conversation"), // consumed by harness.compact()
    ]);
    await drain(agent.invoke({ session: "sB4" }, { text: "tell me things" }));
    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("sB4")) {
        seen.push(ev);
        if (ev.type === "compaction_finished") break;
      }
    })();
    // Acceptance is not outcome: the dispatch answers on ADMISSION (a compaction is a full model
    // call — a remote client's request timeout must not race it).
    const result = await control.dispatch("sB4", { type: "compact" });
    expect(result).toEqual({ ok: true });
    await watching;
    expect(seen.map((e) => e.type)).toEqual(["compaction_started", "compaction_finished"]);
    const finished = seen.at(-1)?.data as { summary: string };
    expect(finished.summary).toBeTruthy();
    // finished ⇒ the lease is free and the record is durable — the ordering the server guarantees.
    const kinds = (await control.entries("sB4")).entries.map((e) => e.kind);
    expect(kinds).toContain("compaction");
    expect((await control.state("sB4")).status).toBe("idle");
  });

  it("while a compaction is in flight the lease is held: state() compacting, dispatch session_busy", async () => {
    // The accept-fast window is the refactor's new invariant: ok returned, lease still held.
    let releaseSummary: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseSummary = r;
    });
    const { agent, control } = makeBoundary([
      fauxAssistantMessage("seed"),
      (async (_c: unknown, _o: unknown, _s: unknown, _m: unknown) => {
        await gate; // the summarization model call hangs until the test releases it
        return fauxAssistantMessage("the summary");
      }) as never,
    ]);
    await drain(agent.invoke({ session: "sB8" }, { text: "hi" }));
    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("sB8")) {
        seen.push(ev);
        if (ev.type === "compaction_finished") break;
      }
    })();
    expect(await control.dispatch("sB8", { type: "compact" })).toEqual({ ok: true });
    // In flight: status reports compacting and the lease rejects other boundary work.
    for (let i = 0; i < 100 && (await control.state("sB8")).status !== "compacting"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await control.state("sB8")).status).toBe("compacting");
    const busy = await control.dispatch("sB8", { type: "set_thinking", level: "low" });
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.error.code).toBe(SESSION_BUSY_CODE);
    releaseSummary();
    await watching;
    // finished ⇒ lease free and status recovered.
    expect((await control.state("sB8")).status).toBe("idle");
    expect(await control.dispatch("sB8", { type: "set_thinking", level: "low" })).toEqual({ ok: true });
  });

  it("nothing-to-compact is a pre-acceptance rejection, not a finished{error} dressed as failure", async () => {
    // The preparation is a cheap local computation — it belongs to admission: the client gets the
    // answer in the dispatch, and started/finished never fire for work that never begins.
    const { control, sessions } = makeBoundary([]);
    await sessions.openOrCreate("sEmpty"); // exists but has no compactable history
    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("sEmpty")) {
        seen.push(ev);
        if (ev.type === "state_changed") break; // the sentinel dispatched after the rejection
      }
    })();
    const result = await control.dispatch("sEmpty", { type: "compact" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Its OWN code (not boundary_command_failed): a client must machine-distinguish "give up"
      // from "re-dispatch once the session grows" without parsing prose.
      expect(result.error.code).toBe(NOTHING_TO_COMPACT_CODE);
      expect(result.error.retryable).toBe(false); // state-dependent: succeeds once the session grows
    }
    expect((await control.state("sEmpty")).status).toBe("idle");
    // Lease free (the sentinel): a boundary mutation succeeds right after the rejection…
    expect(await control.dispatch("sEmpty", { type: "set_thinking", level: "low" })).toEqual({ ok: true });
    await watching;
    // …and the event stream carries ONLY it — no compaction bounds ever fired.
    expect(seen.map((e) => e.type)).toEqual(["state_changed"]);
  });

  it("abort during an in-flight compaction interrupts it — run/compaction symmetry, not no_active_run", async () => {
    // Both are model calls a client must be able to stop: `abort` is the door out of `compacting`.
    const { agent, control } = makeBoundary([
      fauxAssistantMessage("seed"),
      (async (_c: unknown, o: { signal?: AbortSignal } | undefined) => {
        // The summarization call hangs until aborted — the only way this test's compaction ends.
        // Checked up front too: the abort may land BEFORE this factory runs, and an
        // already-aborted signal never fires its "abort" event again.
        await new Promise<never>((_resolve, reject) => {
          const bail = () => reject(new Error("summarization aborted"));
          if (o?.signal?.aborted) return bail();
          o?.signal?.addEventListener("abort", bail, { once: true });
        });
        return fauxAssistantMessage("unreachable");
      }) as never,
    ]);
    await drain(agent.invoke({ session: "sB9" }, { text: "hi" }));
    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("sB9")) {
        seen.push(ev);
        if (ev.type === "compaction_finished") break;
      }
    })();
    expect(await control.dispatch("sB9", { type: "compact" })).toEqual({ ok: true });
    for (let i = 0; i < 100 && (await control.state("sB9")).status !== "compacting"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // The door: abort routes to the compaction's harness — answering no_active_run against a
    // state() that says "compacting" would be a lie.
    expect(await control.dispatch("sB9", { type: "abort" })).toEqual({ ok: true });
    await watching;
    expect(seen.map((e) => e.type)).toEqual(["compaction_started", "compaction_finished"]);
    // A deliberate stop reads as aborted, NOT error — the same vocabulary split as
    // run_settled{status: "aborted"}; a client's own abort must not render as a failure.
    expect(seen.at(-1)?.data).toEqual({ aborted: true });
    // Converged: lease free, status recovered, nothing stuck.
    expect((await control.state("sB9")).status).toBe("idle");
    expect(await control.dispatch("sB9", { type: "set_thinking", level: "low" })).toEqual({ ok: true });
  });

  it("a failing compaction is ACCEPTED then closed with finished{error}; nothing durable, lease free", async () => {
    // ONE response seeds the conversation; the compaction's summarization call then finds the faux
    // queue empty and throws — the deterministic model-call failure, AFTER acceptance.
    const { agent, control } = makeBoundary([fauxAssistantMessage("seed")]);
    await drain(agent.invoke({ session: "sB6" }, { text: "hi" }));
    const seen: SessionEvent[] = [];
    const watching = (async () => {
      for await (const ev of control.events("sB6")) {
        seen.push(ev);
        if (ev.type === "compaction_finished") break; // bounds contract: failure must still close
      }
    })();
    const result = await control.dispatch("sB6", { type: "compact" });
    expect(result).toEqual({ ok: true }); // accept-fast: admission succeeded; the OUTCOME fails
    await watching;
    expect(seen.map((e) => e.type)).toEqual(["compaction_started", "compaction_finished"]);
    const closed = seen.at(-1)?.data as { error?: string };
    expect(closed.error).toBeTruthy();
    // Nothing durable landed, and neither the lease nor the compacting flag is stuck.
    const kinds = (await control.entries("sB6")).entries.map((e) => e.kind);
    expect(kinds).not.toContain("compaction");
    expect((await control.state("sB6")).status).toBe("idle");
    const retry = await control.dispatch("sB6", { type: "set_thinking", level: "low" });
    expect(retry.ok).toBe(true); // the lease was released

    // PRE-acceptance failure (the harness build) still rejects with boundary_command_failed —
    // and releases the lease.
    const sessions = inMemorySessionStore();
    await sessions.openOrCreate("sPre"); // must exist, or no_such_session wins
    const lease = inProcessLease();
    const broke = makeFaux();
    const boundary: PiBoundaryWiring = {
      lease,
      models: broke.models,
      defaults: { model: broke.faux.getModel(), thinkingLevel: "medium" },
      harnessFactory: async () => {
        throw new Error("no harness for you");
      },
    };
    const { control: broken } = createPiSessionControl({ sessions, boundary: () => boundary });
    const pre = await broken.dispatch("sPre", { type: "compact" });
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.error.code).toBe(BOUNDARY_COMMAND_FAILED_CODE);
    expect(lease.tryAcquire("sPre")).not.toBeNull(); // released on the pre-acceptance path
  });

  it("state() reports what will RUN, not what was recorded — including with no overrides at all", async () => {
    // Reporting the raw record made "no override" indistinguishable from "no model".
    const { agent, control, spec } = makeBoundary([fauxAssistantMessage("ok")]);
    await drain(agent.invoke({ session: "sB7" }, { text: "hi" }));
    const fresh = await control.state("sB7");
    expect(fresh.model).toBe(spec); // the assembly default, named — not absent
    expect(fresh.thinkingLevel).toBe("medium");
    expect(fresh.availableThinkingLevels).toContain("high");
    await control.dispatch("sB7", { type: "set_model", model: spec });
    await control.dispatch("sB7", { type: "set_thinking", level: "high" });
    const state = await control.state("sB7");
    expect(state.model).toBe(spec);
    expect(state.thinkingLevel).toBe("high");
  });

  it("the override rides the next turn end to end: set_model changes which model answers", async () => {
    // Two faux models in ONE registry; the response FACTORY answers with the model that was asked —
    // this pins the factory→resolveHarnessOverrides→AgentHarness wiring, not just the resolver.
    const { faux, models } = makeFaux({ models: [{ id: "faux-a" }, { id: "faux-b" }] });
    faux.setResponses([
      (_ctx: unknown, _opts: unknown, _state: unknown, model: { id: string }) =>
        fauxAssistantMessage(`answered by ${model.id}`),
      (_ctx: unknown, _opts: unknown, _state: unknown, model: { id: string }) =>
        fauxAssistantMessage(`answered by ${model.id}`),
    ] as never);
    const sessions = inMemorySessionStore();
    const lease = inProcessLease();
    const factory = piHarnessFactory({
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      sessions,

      models,
      model: faux.getModel("faux-a") as NonNullable<ReturnType<typeof faux.getModel>>, // assembly default
      tools: [],
      systemPrompt: "test",
    });
    const boundary: PiBoundaryWiring = {
      lease,
      models,
      harnessFactory: factory,
      defaults: { model: faux.getModel(), thinkingLevel: "medium" },
    };
    const { control, observer } = createPiSessionControl({ sessions, boundary: () => boundary });
    const agent = createPiAgentFromHarness({ observer, lease, harnessFactory: factory });

    const first = await drain(agent.invoke({ session: "sE2E" }, { text: "hi" }));
    expect(first.map((e) => (e.type === "text" ? (e as { delta: string }).delta : "")).join("")).toContain("faux-a");

    expect(await control.dispatch("sE2E", { type: "set_model", model: `${faux.provider.id}/faux-b` })).toEqual({
      ok: true,
    });
    const second = await drain(agent.invoke({ session: "sE2E" }, { text: "again" }));
    expect(second.map((e) => (e.type === "text" ? (e as { delta: string }).delta : "")).join("")).toContain("faux-b");
  });

  it("events(): detaching from a quiet stream resolves promptly and releases the subscription", async () => {
    const { control, observer } = createPiSessionControl({ sessions: inMemorySessionStore() });
    const iterator = control.events("sQuiet")[Symbol.asyncIterator]();
    const pending = iterator.next(); // registers; the stream never produces
    await new Promise((r) => setTimeout(r, 20));
    await iterator.return?.(undefined); // the old bug: this hung forever behind the quiet pull
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    // Released: a later event for that session finds no subscriber to buffer into — push must not
    // throw, and a NEW subscription starts empty (nothing buffered against the dead one).
    observer("sQuiet", { type: "run_started", timestamp: Date.now(), runId: "r9", data: {} });
    const fresh = control.events("sQuiet")[Symbol.asyncIterator]();
    const race = await Promise.race([fresh.next(), new Promise((r) => setTimeout(() => r("empty"), 50))]);
    expect(race).toBe("empty"); // the pre-subscription event was not buffered anywhere
    await fresh.return?.(undefined);
    // done is TERMINAL: a post-return next() answers done — it must not silently re-register.
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  }, 5_000);

  it("a workspace caller observer receives the full vocabulary, boundary events included", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "fa-sc-tap-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "fastagent"));
      await writeFile(
        join(dir, "fastagent", "fastagent.config.mjs"),
        `export default { model: "openai-codex/gpt-5.5" };\n`,
      );
      const seen: string[] = [];
      const opened = await createPiAgentFromDir(dir, {
        sessionControl: true,
        observer: (_s, event) => {
          seen.push(event.type);
        },
      });
      const control = opened.sessionControl as NonNullable<typeof opened.sessionControl>;
      // Seed a session WITHOUT a model call: boundary mutations need an existing session, and the
      // observer tap must then see the hub-generated state_changed — the audit-tap guarantee.
      await opened.sessions.openOrCreate("sTap");
      const result = await control.dispatch("sTap", { type: "set_thinking", level: "low" });
      expect(result.ok).toBe(true);
      expect(seen).toContain("state_changed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("boundary mutations never mint sessions: unknown id rejects no_such_session", async () => {
    const { control, sessions, spec } = makeBoundary([]);
    const result = await control.dispatch("ghost", { type: "set_model", model: spec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(NO_SUCH_SESSION_CODE);
    expect(await sessions.openIfExists("ghost")).toBeUndefined(); // no ghost record landed
    const compact = await control.dispatch("ghost", { type: "compact" });
    expect(compact.ok).toBe(false);
    if (!compact.ok) expect(compact.error.code).toBe(NO_SUCH_SESSION_CODE);
  });

  it("without boundary wiring the commands stay gated off and rejected", async () => {
    const { control } = makeObserved([]); // observation + run modulation only
    const caps = control.capabilities();
    expect(caps.manualCompaction).toBe(false);
    expect(caps.modelSelection).toBe(false);
    const result = await control.dispatch("sB5", { type: "set_model", model: "any/thing" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(UNSUPPORTED_CAPABILITY_CODE);
  });
});
