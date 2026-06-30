import { describe, expect, it, vi } from "vitest";
import { readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { inMemorySessionStore, jsonlSessionStore, type AgentEvent, type PiSessionStore } from "../src/index.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { makeFaux } from "./faux.ts";

/** Agent over an injected store (the store is the variable under test). */
function makeAgent(sessions: PiSessionStore, responses: FauxResponseStep[]) {
  const { faux, models } = makeFaux();
  faux.setResponses(responses);
  return createPiAgentFromHarness({
    harnessFactory: piHarnessFactory({
      sessions,
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      systemPrompt: "test",
    }),
  });
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("jsonlSessionStore (persistent sessions, first K-axis backend)", () => {
  it("restart survival: a new store instance using the same directory sees the previous process history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sessions-"));

    // "process 1":run one turn and persist it
    const agent1 = makeAgent(jsonlSessionStore({ dir }), [fauxAssistantMessage("the answer is blue")]);
    const e1 = await drain(agent1.invoke({ session: "conv" }, { text: "what color?" }));
    expect(e1.at(-1)?.type).toBe("completed");

    // "process 2":new store instance, same directory: history must remain because disk is the source of truth
    let turn2: unknown;
    const agent2 = makeAgent(jsonlSessionStore({ dir }), [
      (context) => {
        turn2 = context.messages;
        return fauxAssistantMessage("still blue");
      },
    ]);
    const e2 = await drain(agent2.invoke({ session: "conv" }, { text: "remind me" }));
    expect(e2.at(-1)?.type).toBe("completed");

    const dump = JSON.stringify(turn2);
    expect(dump).toContain("what color?"); // turn-1 user
    expect(dump).toContain("the answer is blue"); // turn-1 assistant
    expect(dump).toContain("remind me"); // turn-2 user
  });

  it("different sessions do not leak into each other within one store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    const store = jsonlSessionStore({ dir });

    await drain(
      makeAgent(store, [fauxAssistantMessage("secret hunter2")]).invoke(
        { session: "A" },
        { text: "remember the secret" },
      ),
    );
    let other: unknown;
    await drain(
      makeAgent(store, [
        (context) => {
          other = context.messages;
          return fauxAssistantMessage("nothing");
        },
      ]).invoke({ session: "B" }, { text: "what do you know?" }),
    );

    expect(JSON.stringify(other)).not.toContain("hunter2");
  });

  it("two stores with the same sessionsRoot but different cwd do not open each other sessions (project isolation)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    const cwdA = await mkdtemp(join(tmpdir(), "fa-proj-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "fa-proj-b-"));

    await drain(
      makeAgent(jsonlSessionStore({ dir, cwd: cwdA }), [fauxAssistantMessage("secret hunter2")]).invoke(
        { session: "same-id" },
        { text: "remember the secret" },
      ),
    );
    let other: unknown;
    await drain(
      makeAgent(jsonlSessionStore({ dir, cwd: cwdB }), [
        (context) => {
          other = context.messages;
          return fauxAssistantMessage("nothing");
        },
      ]).invoke({ session: "same-id" }, { text: "what do you know?" }),
    );

    expect(JSON.stringify(other)).not.toContain("hunter2"); // B cannot see A same-named session
  });
});

describe("crash-safety: reconcile interrupted tool calls on open", () => {
  /** ids of assistant tool_use blocks that have no matching toolResult (a poisoned transcript). */
  const danglingToolCalls = (messages: any[]): string[] => {
    const settled = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
    const out: string[] = [];
    for (const m of messages) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b?.type === "toolCall" && !settled.has(b.id)) out.push(b.id);
    }
    return out;
  };

  /** Simulate a turn that died mid tool-execution: assistant(tool_use) persisted, NO result. */
  async function poison(store: PiSessionStore, id: string) {
    const s = await store.openOrCreate(id);
    await s.appendMessage({ role: "user", content: [{ type: "text", text: "run it" }], timestamp: Date.now() } as any);
    await s.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "x" } }],
      provider: "faux",
      model: "faux",
      stopReason: "toolUse",
      usage: { input: 0, output: 0 },
      timestamp: Date.now(),
    } as any);
  }

  it("reopening a crashed session repairs the gap with an interrupted error result", async () => {
    const store = inMemorySessionStore();
    await poison(store, "crashed");

    const reopened = await store.openOrCreate("crashed"); // open -> reconcile fires
    const { messages } = await reopened.buildContext();

    expect(danglingToolCalls(messages)).toEqual([]); // no more dangling tool_use
    const repaired = messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "call-1") as any;
    expect(repaired.isError).toBe(true);
    // customer-facing contract: the model-visible text is neutral and decision-guiding,
    // never "aborted" (cancellation misread) and never leaking infra detail (relayable to users).
    const text = repaired.content[0].text as string;
    expect(text).toMatch(/did not complete/i);
    expect(text).not.toMatch(/abort|crash|restart|process/i);
    // operational marker lives in details (not sent to the provider), for developer observability.
    expect(repaired.details).toMatchObject({ fastagent: "interrupted-tool-call" });
  });

  it("a retry after the crash now completes instead of being rejected by a pairing-validating provider", async () => {
    const store = inMemorySessionStore();
    await poison(store, "crashed");

    let contextSeen: any[] = [];
    const agent = makeAgent(store, [
      (context) => {
        contextSeen = context.messages;
        // Mirror Anthropic/OpenAI: reject an assistant tool_use without a matching tool_result.
        return danglingToolCalls(context.messages).length > 0
          ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 tool_use without tool_result" })
          : fauxAssistantMessage("recovered");
      },
    ]);

    const events = await drain(agent.invoke({ session: "crashed" }, { text: "are you there?" }));
    expect(danglingToolCalls(contextSeen)).toEqual([]); // the provider never sees a dangling call
    expect(events.at(-1)?.type).toBe("completed"); // was "failed" before the reconcile fix
  });

  it("a clean session is untouched (no spurious results appended)", async () => {
    const store = inMemorySessionStore();
    await drain(makeAgent(store, [fauxAssistantMessage("hello")]).invoke({ session: "clean" }, { text: "hi" }));
    const reopened = await store.openOrCreate("clean");
    const { messages } = await reopened.buildContext();
    expect(messages.some((m: any) => m.role === "toolResult")).toBe(false);
  });

  it("a leaf call behind later history is surfaced, not silently appended (fail visibly)", async () => {
    // The leaf's dangling call is followed by a later turn (a user prompt) rather than only its
    // own results, so appending to an append-only log cannot repair it; surface instead.
    const store = inMemorySessionStore();
    const s = await store.openOrCreate("mid-history");
    await s.appendMessage({ role: "user", content: [{ type: "text", text: "run it" }], timestamp: Date.now() } as any);
    await s.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "x" } }],
      provider: "faux",
      model: "faux",
      stopReason: "toolUse",
      usage: { input: 0, output: 0 },
      timestamp: Date.now(),
    } as any);
    // a later turn lands after the dangling call without it ever being reconciled
    await s.appendMessage({
      role: "user",
      content: [{ type: "text", text: "still there?" }],
      timestamp: Date.now(),
    } as any);

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reopened = await store.openOrCreate("mid-history"); // open -> reconcile
      const { messages } = await reopened.buildContext();
      expect(messages.some((m: any) => m.role === "toolResult")).toBe(false); // NOT appended
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("call-1")); // surfaced instead
    } finally {
      warn.mockRestore();
    }
  });

  it("a mid-history gap behind a later assistant turn is surfaced, not ignored", async () => {
    // History: assistant(call-1) -> user -> assistant(error). The dangling call-1 is NOT on the
    // leaf assistant; scanning every turn (not only the leaf) must still surface it.
    const store = inMemorySessionStore();
    const s = await store.openOrCreate("mid-later-assistant");
    await s.appendMessage({ role: "user", content: [{ type: "text", text: "run it" }], timestamp: Date.now() } as any);
    await s.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "x" } }],
      provider: "faux",
      model: "faux",
      stopReason: "toolUse",
      usage: { input: 0, output: 0 },
      timestamp: Date.now(),
    } as any);
    await s.appendMessage({
      role: "user",
      content: [{ type: "text", text: "still there?" }],
      timestamp: Date.now(),
    } as any);
    await s.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "sorry, failed" }],
      provider: "faux",
      model: "faux",
      stopReason: "error",
      usage: { input: 0, output: 0 },
      timestamp: Date.now(),
    } as any);

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reopened = await store.openOrCreate("mid-later-assistant"); // open -> reconcile
      const { messages } = await reopened.buildContext();
      expect(messages.some((m: any) => m.role === "toolResult")).toBe(false); // NOT appended
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("call-1")); // surfaced (leaf has no tool_use)
    } finally {
      warn.mockRestore();
    }
  });

  it("pairing is turn-local: a reused tool-call id from an earlier turn does not mask a leaf gap", async () => {
    // tool-call ids are not globally unique (a model may restart at call-1 each turn). An earlier
    // *completed* call-1 must NOT make a later crashed call-1 look already paired.
    const store = inMemorySessionStore();
    const s = await store.openOrCreate("reused-id");
    // turn 1: call-1 ran and completed
    await s.appendMessage({ role: "user", content: [{ type: "text", text: "first" }], timestamp: Date.now() } as any);
    await s.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "a" } }],
      provider: "faux",
      model: "faux",
      stopReason: "toolUse",
      usage: { input: 0, output: 0 },
      timestamp: Date.now(),
    } as any);
    await s.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "echo",
      content: [{ type: "text", text: "a" }],
      isError: false,
      timestamp: Date.now(),
    } as any);
    await s.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done turn 1" }],
      provider: "faux",
      model: "faux",
      stopReason: "stop",
      usage: { input: 0, output: 0 },
      timestamp: Date.now(),
    } as any);
    // turn 2: call-1 reused, crashed before its result
    await s.appendMessage({ role: "user", content: [{ type: "text", text: "second" }], timestamp: Date.now() } as any);
    await s.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "b" } }],
      provider: "faux",
      model: "faux",
      stopReason: "toolUse",
      usage: { input: 0, output: 0 },
      timestamp: Date.now(),
    } as any);

    const reopened = await store.openOrCreate("reused-id"); // open -> reconcile
    const { messages } = await reopened.buildContext();
    // the leaf call-1 must be repaired despite the earlier paired call-1 (turn-local pairing)
    const interrupted = messages.filter(
      (m: any) => m.role === "toolResult" && m.details?.fastagent === "interrupted-tool-call",
    );
    expect(interrupted).toHaveLength(1);
    expect((interrupted[0] as any).toolCallId).toBe("call-1");
    // and the leaf is now valid: its call has a following result
    expect(messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "call-1", isError: true });
  });
});

describe("jsonlSessionStore (malicious id)", () => {
  it("malicious session id cannot escape the sessions directory because it is filename-encoded and can round-trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-sessions-"));
    const dir = join(root, "sessions");
    const store = jsonlSessionStore({ dir, cwd: root });
    const evil = "../../escape/me";

    const e1 = await drain(makeAgent(store, [fauxAssistantMessage("ok")]).invoke({ session: evil }, { text: "hi" }));
    expect(e1.at(-1)?.type).toBe("completed");

    // only sessions/ is created under root; no escape/ or other path breakout appears
    expect((await readdir(root)).sort()).toEqual(["sessions"]);

    // the same odd id resumes the same session because encoding is deterministic and injective
    let turn2: unknown;
    await drain(
      makeAgent(store, [
        (context) => {
          turn2 = context.messages;
          return fauxAssistantMessage("again");
        },
      ]).invoke({ session: evil }, { text: "continue" }),
    );
    expect(JSON.stringify(turn2)).toContain("hi"); // turn 1 is still present
  });
});
