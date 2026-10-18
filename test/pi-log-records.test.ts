/**
 * What a pi session's log reads as through SPEC v1 (log-records.ts): how each answer ended, the thinking it published,
 * the tool calls it made and their results, the images a message carries, context edits, and how full the context
 * is. A record is read back by an agent that never saw the run, so what is asserted is what the record itself says.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type PiSessionRecordStore, piSessionRecordStore } from "../src/harnesses/pi/session-store.ts";
import { defineTool } from "../src/harnesses/pi/tool.ts";
import type { Agent, Entry, InvokeEvent, Outcome, SessionState } from "../src/protocol.ts";
import { fauxAgent } from "./agent.ts";

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

async function invoked(events: AsyncIterable<InvokeEvent>): Promise<InvokeEvent[]> {
  const out: InvokeEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
const run = (agent: Agent, sessionId: string, text = "go") => invoked(agent.invoke({ sessionId, prompt: { text } }));
const outcomeOf = (events: InvokeEvent[]): Outcome | undefined =>
  events.flatMap((e) => (e.type === "done" ? [e.message.outcome] : []))[0];
const deltas = (events: InvokeEvent[], channel: "text" | "thinking") =>
  events.flatMap((e) => (e.type === "message_delta" && e.channel === channel ? [e.delta] : [])).join("");

async function entries(agent: Agent, sessionId: string): Promise<Entry[]> {
  const read = await agent.sessions.get(sessionId).read({ limit: 500 });
  if (!read.ok) throw new Error(read.error.message);
  return read.entries;
}
async function stateOf(agent: Agent, sessionId: string): Promise<SessionState> {
  const read = await agent.sessions.get(sessionId).read({ limit: 0 });
  if (!read.ok) throw new Error(read.error.message);
  return read.state;
}
const answers = (all: Entry[]) => all.filter((e) => e.kind === "assistant_message");

/** A disk store, and a second agent over the same directory that never saw the runs. */
async function onDisk(): Promise<{ sessions: () => PiSessionRecordStore; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "fa-log-records-"));
  const dir = join(cwd, "sessions");
  return { sessions: () => piSessionRecordStore({ dir, cwd }), cwd };
}

describe("an answer", () => {
  it("its text and thinking read back as the live deltas added up", async () => {
    const { agent } = fauxAgent([fauxAssistantMessage([fauxThinking("hmm"), { type: "text", text: "answer" }])]);
    const events = await run(agent, "s1");
    expect(deltas(events, "text")).toBe("answer");
    expect(deltas(events, "thinking")).toBe("hmm");
    expect(answers(await entries(agent, "s1")).at(-1)?.data).toMatchObject({ text: "answer", thinking: "hmm" });
  });

  it("its thinking reads back as the blocks joined as streamed, a stopped one included, a redacted one never", async () => {
    const cases = [
      {
        sessionId: "kSteps",
        answer: fauxAssistantMessage([
          fauxThinking("first step. "),
          { type: "text", text: "answer" },
          fauxThinking("second step."),
        ]),
        thinking: "first step. second step.",
      },
      {
        // Stopped mid-answer: what was thought so far was streamed, and stays readable.
        sessionId: "kAborted",
        answer: fauxAssistantMessage([fauxThinking("half a thought")], {
          stopReason: "aborted",
          errorMessage: "Request aborted",
        }),
        thinking: "half a thought",
      },
      { sessionId: "kNone", answer: fauxAssistantMessage("no thinking"), thinking: undefined },
    ];
    for (const c of cases) {
      const { agent } = fauxAgent([c.answer]);
      const live = deltas(await run(agent, c.sessionId), "thinking");
      const entry = answers(await entries(agent, c.sessionId)).at(-1);
      expect(live, c.sessionId).toBe(c.thinking ?? "");
      if (c.thinking === undefined) expect(entry?.data, c.sessionId).not.toHaveProperty("thinking");
      else expect(entry?.data, c.sessionId).toMatchObject({ thinking: c.thinking });
    }
    // Only the record half: faux streams a scripted block without its `redacted` flag, which no provider does, so the
    // live half is live-events.test.ts's.
    const redacted = { ...fauxThinking("[Reasoning redacted]"), redacted: true, thinkingSignature: "opaque" };
    const { agent } = fauxAgent([
      fauxAssistantMessage([fauxThinking("readable"), redacted, { type: "text", text: "ok" }]),
    ]);
    await run(agent, "kRedacted");
    expect(answers(await entries(agent, "kRedacted")).at(-1)?.data).toMatchObject({ thinking: "readable" });
  });

  it("says how it ended, and its run's outcome agrees; a normal one says nothing", async () => {
    const cases = [
      {
        answer: fauxAssistantMessage("partial answer", { stopReason: "error", errorMessage: "invalid api key" }),
        outcome: { status: "failed", error: { message: "invalid api key" } },
        run: { status: "failed" },
      },
      {
        answer: fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request aborted" }),
        outcome: { status: "aborted", error: { message: "Request aborted" } },
        run: { status: "failed" },
      },
      // Cut off at the output limit: the answer's property; the run says so as max_tokens.
      {
        answer: fauxAssistantMessage("cut off", { stopReason: "length" }),
        outcome: { status: "truncated" },
        run: { status: "max_tokens" },
      },
      { answer: fauxAssistantMessage("done"), outcome: undefined, run: { status: "completed" } },
    ];
    for (const c of cases) {
      const { agent } = fauxAgent([c.answer]);
      const events = await run(agent, "o");
      const entry = answers(await entries(agent, "o")).at(-1);
      const label = c.outcome?.status ?? "normal";
      expect(outcomeOf(events), label).toMatchObject(c.run);
      if (c.outcome) expect(entry?.data, label).toMatchObject({ outcome: c.outcome });
      else expect(entry?.data, label).not.toHaveProperty("outcome");
    }
  });

  it("a failure recorded before the stop stays failed: a provider error whose retry is stopped during its backoff", async () => {
    // Fails before saying anything, so pi schedules a retry (a 2s backoff); the second response is never asked for.
    const { agent } = fauxAgent([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom 500" }),
      fauxAssistantMessage("never"),
    ]);
    const events: InvokeEvent[] = [];
    for await (const event of agent.invoke({ sessionId: "aBackoff", prompt: { text: "go" } })) {
      events.push(event);
      if (event.type === "retry_scheduled") await agent.sessions.get("aBackoff").abort();
    }
    expect(events.map((e) => e.type)).toContain("retry_scheduled");
    expect(outcomeOf(events)).toMatchObject({ status: "canceled" }); // the RUN was stopped
    // The answer failed on its own, before the stop.
    expect(answers(await entries(agent, "aBackoff")).map((e) => e.data)).toEqual([
      { text: "", outcome: { status: "failed", error: { message: "boom 500" } } },
    ]);
  });
});

describe("tool calls", () => {
  it("an answer's calls carry the args tool_started showed, and their results follow", async () => {
    const { agent } = fauxAgent(
      [fauxAssistantMessage(fauxToolCall("echo", { value: "ping" }, { id: "call-1" })), fauxAssistantMessage("done")],
      { tools: [echoTool] },
    );
    const events = await run(agent, "sT");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_started", toolCallId: "call-1", name: "echo", args: { value: "ping" } }),
    );
    const all = await entries(agent, "sT");
    // A reopened conversation shows the same call a live watcher saw.
    expect(answers(all)[0]?.data).toMatchObject({
      toolCalls: [{ id: "call-1", name: "echo", args: { value: "ping" } }],
    });
    expect(all.find((e) => e.kind === "tool_result")?.data).toEqual({
      toolCallId: "call-1",
      toolName: "echo",
      isError: false,
      text: "ping",
    });
  });

  it("a run stopped during a tool records the call as failed and its last answer as aborted", async () => {
    const started = Promise.withResolvers<void>();
    const waitTool: AgentTool = {
      name: "wait",
      label: "Wait",
      description: "Waits until stopped",
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        started.resolve();
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("Command aborted");
      },
    };
    const disk = await onDisk();
    const { agent } = fauxAgent(
      [
        fauxAssistantMessage([{ type: "text", text: "Running it." }, fauxToolCall("wait", {}, { id: "c1" })], {
          stopReason: "toolUse",
        }),
      ],
      { tools: [waitTool], cwd: disk.cwd, sessions: disk.sessions() },
    );
    const running = run(agent, "aTool");
    await started.promise;
    expect(await agent.sessions.get("aTool").abort()).toMatchObject({ ok: true });
    expect(outcomeOf(await running)).toMatchObject({ status: "canceled" });

    const reopened = fauxAgent([], { cwd: disk.cwd, sessions: disk.sessions() });
    const all = await entries(reopened.agent, "aTool");
    expect(all.find((e) => e.kind === "tool_result")?.data).toMatchObject({ toolCallId: "c1", isError: true });
    expect(answers(all).at(-1)?.data).toMatchObject({ outcome: { status: "aborted" } });
  });

  it("a failed answer's calls never ran; a truncated answer's calls are recorded as failed and the run goes on", async () => {
    const failed = fauxAgent(
      [
        fauxAssistantMessage(fauxToolCall("echo", { value: "x" }, { id: "call-f" }), {
          stopReason: "error",
          errorMessage: "invalid api key",
        }),
      ],
      { tools: [echoTool] },
    );
    expect((await run(failed.agent, "tFailed")).some((e) => e.type === "tool_started")).toBe(false);
    const failedEntries = await entries(failed.agent, "tFailed");
    expect(answers(failedEntries)[0]?.data).toMatchObject({
      toolCalls: [{ id: "call-f" }],
      outcome: { status: "failed" },
    });
    expect(failedEntries.some((e) => e.kind === "tool_result")).toBe(false);

    const truncated = fauxAgent(
      [
        fauxAssistantMessage(fauxToolCall("echo", { value: "x" }, { id: "call-t" }), { stopReason: "length" }),
        fauxAssistantMessage("done"),
      ],
      { tools: [echoTool] },
    );
    await run(truncated.agent, "tTruncated");
    const truncatedEntries = await entries(truncated.agent, "tTruncated");
    expect(truncatedEntries.find((e) => e.kind === "tool_result")?.data).toMatchObject({
      toolCallId: "call-t",
      isError: true,
    });
    expect(answers(truncatedEntries).at(-1)?.data).toEqual({ text: "done" });
  });

  it("a result that ends its run says so in the record; one batched with a call that does not, does not end it", async () => {
    const endTool: AgentTool = {
      name: "finish",
      label: "Finish",
      description: "Hand off and end the run",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "handed off" }], details: {}, terminate: true };
      },
    };
    const disk = await onDisk();
    // ONE model response: a second model call would find none and fail the run.
    const ended = fauxAgent(
      [fauxAssistantMessage([fauxToolCall("finish", {}, { id: "call-end" })], { stopReason: "toolUse" })],
      {
        tools: [endTool, echoTool],
        cwd: disk.cwd,
        sessions: disk.sessions(),
      },
    );
    expect(outcomeOf(await run(ended.agent, "eEnded"))).toEqual({ status: "completed" });
    // Read back by a store that never saw the run: the record itself carries it.
    const reopened = fauxAgent([], { cwd: disk.cwd, sessions: disk.sessions() });
    expect((await entries(reopened.agent, "eEnded")).filter((e) => e.kind === "tool_result").at(-1)).toMatchObject({
      data: { toolCallId: "call-end", terminate: true },
    });

    const wentOn = fauxAgent(
      [
        fauxAssistantMessage(
          [fauxToolCall("finish", {}, { id: "call-a" }), fauxToolCall("echo", { value: "x" }, { id: "call-b" })],
          {
            stopReason: "toolUse",
          },
        ),
        fauxAssistantMessage("done"),
      ],
      { tools: [endTool, echoTool] },
    );
    await run(wentOn.agent, "eWentOn");
    const wentOnEntries = await entries(wentOn.agent, "eWentOn");
    expect(
      wentOnEntries.filter((e) => e.kind === "tool_result").map((e) => (e.data as { terminate?: true }).terminate),
    ).toEqual([true, undefined]);
    expect(answers(wentOnEntries).at(-1)?.data).toMatchObject({ text: "done" });

    // Run from inside another tool, the asking call is not in the batch: the run goes on and nothing says it ended.
    const finish = defineTool({
      name: "finish",
      description: "Hand off and end the run",
      input: z.object({}),
      execute: async () => ({ content: [{ type: "text", text: "handed off" }], details: {}, terminate: true }),
    });
    const outer = defineTool({
      name: "outer",
      description: "Runs finish",
      input: z.object({}),
      execute: async (_input, ctx) => (await ctx.executeTool?.("finish", {}))?.isError ?? "no executeTool",
    });
    const nested = fauxAgent(
      [
        fauxAssistantMessage([fauxToolCall("outer", {}, { id: "call-o" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
      { tools: [finish, outer] },
    );
    await run(nested.agent, "eNested");
    const nestedEntries = await entries(nested.agent, "eNested");
    expect(nestedEntries.filter((e) => e.kind === "tool_result" && "terminate" in (e.data as object))).toEqual([]);
    expect(answers(nestedEntries).at(-1)?.data).toMatchObject({ text: "done" });
  });
});

describe("messages", () => {
  it("a steer is recorded as a user message after the answer it interrupted, before the answer to it", async () => {
    // pi awaits extension `message_end` handlers before it appends a message; a slow one is the case where a report
    // could run ahead of the record. Entries reach a caller as they are written, so each is readable when it arrives.
    const dir = await mkdtemp(join(tmpdir(), "fa-user-message-"));
    const slowWrite = join(dir, "slow-write.mjs");
    await writeFile(
      slowWrite,
      `export default (pi) => pi.on("message_end", async (e) => {\n` +
        `  if (e.message.role === "user") await new Promise((r) => setTimeout(r, 30));\n});\n`,
    );
    for (const [label, sessions] of [
      ["memory", undefined],
      ["disk", piSessionRecordStore({ dir: join(dir, "sessions") })],
    ] as const) {
      const released = Promise.withResolvers<void>();
      const toolStarted = Promise.withResolvers<void>();
      const gate: AgentTool = {
        name: "gate",
        label: "Gate",
        description: "Blocks until released",
        parameters: Type.Object({}),
        async execute() {
          toolStarted.resolve();
          await released.promise;
          return { content: [{ type: "text", text: "gate opened" }], details: {} };
        },
      };
      const { agent } = fauxAgent(
        [fauxAssistantMessage(fauxToolCall("gate", {}, { id: "g1" })), fauxAssistantMessage("steered answer")],
        { tools: [gate], extensionPaths: [slowWrite], ...(sessions ? { sessions } : {}) },
      );
      const seen: string[] = [];
      const readable: boolean[] = [];
      const running = (async () => {
        for await (const event of agent.invoke({ sessionId: "sU", prompt: { text: "go" } })) {
          if (event.type !== "entry") continue;
          const { kind, data, id } = event.entry;
          if (kind === "user_message") {
            seen.push(`user:${(data as { text: string }).text}`);
            readable.push((await entries(agent, "sU")).some((e) => e.id === id));
          } else if (kind === "assistant_message") seen.push("answer");
          else if (kind === "tool_result") seen.push("tool");
        }
      })();
      await toolStarted.promise;
      // The steer's stream ends with its own done, so it is read alongside the first.
      const steered = invoked(agent.invoke({ sessionId: "sU", prompt: { text: "a steer" }, whenBusy: "steer" }));
      released.resolve();
      await running;
      expect((await steered).at(-1), label).toMatchObject({
        type: "done",
        message: { answer: { text: "steered answer" } },
      });
      expect(seen, label).toEqual(["user:go", "answer", "tool", "user:a steer", "answer"]);
      expect(readable, label).toEqual([true, true]);
    }
  });

  it("a message an extension sends is a user message; the command typed is not, and an image-only prompt has empty text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-user-message-ext-"));
    const command = join(dir, "go.mjs");
    await writeFile(
      command,
      `export default (pi) => pi.registerCommand("go", { description: "", handler: async (args) => pi.sendUserMessage("from command " + args) });\n`,
    );
    const { agent } = fauxAgent([fauxAssistantMessage("a"), fauxAssistantMessage("b")], { extensionPaths: [command] });
    const users = async (prompt: { text: string; images?: { mimeType: string; data: string }[] }) =>
      (await invoked(agent.invoke({ sessionId: "sX", prompt }))).flatMap((e) =>
        e.type === "entry" && e.entry.kind === "user_message" ? [(e.entry.data as { text: string }).text] : [],
      );
    expect(await users({ text: "/go X" })).toEqual(["from command X"]);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    expect(await users({ text: "", images: [{ mimeType: "image/png", data: png }] })).toEqual([""]);
  });

  it("images are listed by ref on user and tool entries, and read by attachment(ref) in that session only", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const red = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const screenshot: AgentTool = {
      name: "screenshot",
      label: "Screenshot",
      description: "Take a screenshot",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "image", data: red, mimeType: "image/png" }], details: {} };
      },
    };
    const disk = await onDisk();
    const { agent } = fauxAgent(
      [
        fauxAssistantMessage(fauxToolCall("screenshot", {}, { id: "c1" })),
        fauxAssistantMessage("done"),
        fauxAssistantMessage("plain"),
      ],
      { tools: [screenshot], cwd: disk.cwd, sessions: disk.sessions() },
    );
    const s = agent.sessions.get("img");
    const sent = [
      { data: png, mimeType: "image/png" },
      { data: red, mimeType: "image/png" },
    ];
    await invoked(agent.invoke({ sessionId: "img", prompt: { text: "look", images: sent } }));
    const all = await entries(agent, "img");
    const refs = (kind: string) =>
      ((all.find((e) => e.kind === kind) as Entry).data as { images: { ref: string }[] }).images.map((i) => i.ref);
    const user = all.find((e) => e.kind === "user_message") as Entry;
    expect(user.data).toEqual({
      text: "look",
      messageId: expect.any(String),
      images: [
        { ref: expect.any(String), mimeType: "image/png" },
        { ref: expect.any(String), mimeType: "image/png" },
      ],
    });
    expect(await Promise.all(refs("user_message").map((ref) => s.attachment(ref)))).toEqual(sent);
    expect(await Promise.all(refs("tool_result").map((ref) => s.attachment(ref)))).toEqual([
      { data: red, mimeType: "image/png" },
    ]);

    // A message with no images keeps its shape; a ref reaches nothing outside its own session or list.
    await invoked(agent.invoke({ sessionId: "img", prompt: { text: "no picture" } }));
    expect((await entries(agent, "img")).filter((e) => e.kind === "user_message").at(-1)?.data).toEqual({
      text: "no picture",
      messageId: expect.any(String),
    });
    const assistant = answers(all)[0] as Entry;
    expect(await agent.sessions.get("other").attachment(refs("user_message")[0] as string)).toBeUndefined();
    for (const ref of [`${user.id}:2`, `${assistant.id}:0`, user.id, "nope"])
      expect(await s.attachment(ref)).toBeUndefined();
  });

  it("a context edit names the entry the model no longer sees as written", async () => {
    // pi writes an omission (`replacement: null`) for every abandoned retry or overflow attempt, and an extension may
    // write omissions or replacements. The target stays in the transcript, so without the edit's target a client
    // cannot tell it from an entry the model still sees as written.
    const { agent, sessions } = fauxAgent([]);
    const record = await sessions.openOrCreate("sEdit");
    record.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const attempt = record.appendMessage(fauxAssistantMessage("abandoned attempt"));
    record.appendContextEdit(attempt, null);
    const answer = record.appendMessage(fauxAssistantMessage("answer"));
    record.appendContextEdit(answer, { content: "shortened answer" });
    expect((await entries(agent, "sEdit")).filter((e) => e.kind === "context_edit").map((e) => e.data)).toEqual([
      { targetId: attempt, omitted: true },
      { targetId: answer, omitted: false },
    ]);
  });
});

describe("how full the context is", () => {
  const usage = (input: number, output: number) =>
    ({
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }) as const;

  it("after a run it is exactly pi's own count, with the model's window", async () => {
    const { agent, sessions, faux, models } = fauxAgent([fauxAssistantMessage("an answer")]);
    await run(agent, "sUsage", "question");
    const record = await sessions.openIfExists("sUsage");
    if (!record) throw new Error("no record");
    const model = faux.getModel();
    // pi's own number for the same record and model: what a live session would report.
    const { session: bound } = await createAgentSession({
      sessionManager: record,
      model,
      modelRuntime: await models(),
    });
    const expected = bound.getContextUsage();
    bound.dispose();
    expect(expected?.tokens).toBeGreaterThan(0);
    expect((await stateOf(agent, "sUsage")).context).toEqual({ tokens: expected?.tokens, window: model.contextWindow });
  });

  it("what followed the answer is estimated the way pi estimates it", async () => {
    const { agent, sessions, faux, models } = fauxAgent([]);
    const record = await sessions.openOrCreate("sTrailing");
    record.appendMessage({ role: "user", content: "run it", timestamp: 1 });
    record.appendMessage({
      ...fauxAssistantMessage(fauxToolCall("echo", { value: "x" }, { id: "t1" })),
      usage: usage(10, 5),
    } as never);
    record.appendMessage({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "echo",
      content: [{ type: "text", text: "r".repeat(4000) }],
      isError: false,
      timestamp: 2,
    } as never);
    const { session: bound } = await createAgentSession({
      model: faux.getModel(),
      sessionManager: record,
      modelRuntime: await models(),
    });
    const expected = bound.getContextUsage();
    bound.dispose();
    expect(expected?.tokens).toBeGreaterThan(15);
    expect((await stateOf(agent, "sTrailing")).context?.tokens).toBe(expected?.tokens);
  });

  it("is unknown, not zero, once a compaction or a context edit follows the answer; none before any answer", async () => {
    const { agent, sessions } = fauxAgent([]);
    const edited = await sessions.openOrCreate("sEdited");
    edited.appendMessage({ role: "user", content: "question", timestamp: 1 });
    expect(await stateOf(agent, "sEdited")).not.toHaveProperty("context");
    const answer = edited.appendMessage({ ...fauxAssistantMessage("answer"), usage: usage(10, 5) } as never);
    expect((await stateOf(agent, "sEdited")).context?.tokens).toBe(15);
    edited.appendContextEdit(answer, null);
    expect((await stateOf(agent, "sEdited")).context?.tokens).toBeUndefined();

    const compacted = await sessions.openOrCreate("sCompacted");
    compacted.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const kept = compacted.appendMessage({ ...fauxAssistantMessage("answer"), usage: usage(10, 5) } as never);
    compacted.appendCompaction("summary", kept, 15);
    expect((await stateOf(agent, "sCompacted")).context?.tokens).toBeUndefined();
  });

  it("a moved branch head reports the count its path now has, or none", async () => {
    const { agent, sessions } = fauxAgent([]);
    const record = await sessions.openOrCreate("sMove");
    const question = record.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const first = record.appendMessage({ ...fauxAssistantMessage("answer 100"), usage: usage(100, 1) } as never);
    record.appendMessage({ role: "user", content: "second", timestamp: 2 });
    record.appendMessage({ ...fauxAssistantMessage("answer 900"), usage: usage(900, 1) } as never);
    expect((await stateOf(agent, "sMove")).context?.tokens).toBe(901);
    expect(await agent.sessions.get("sMove").rewind(first)).toEqual({ ok: true });
    expect((await stateOf(agent, "sMove")).context?.tokens).toBe(101);
    expect(await agent.sessions.get("sMove").rewind(question)).toEqual({ ok: true }); // before any answer
    expect((await stateOf(agent, "sMove")).context?.tokens).toBeUndefined();
  });
});
