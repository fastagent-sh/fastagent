import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Agent,
  AgentError,
  type AgentInfo,
  type Entry,
  type Message,
  type SendRequest,
  type Session,
  type SessionEvent,
} from "@fastagent-sh/client";
import {
  REMOTE_ENTRY_TYPE,
  RemoteController,
  TerminalStatusReporter,
  buildSendContent,
  connectRemote,
  loadRemotes,
  registerFastAgentRemoteExtension,
  removeRemote,
  saveRemote,
} from "@fastagent-sh/pi-remote";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-remote-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface StreamController {
  push(event: SessionEvent): void;
  fail(error: Error): void;
  close(): void;
}

function createEventStream(): { iterable: AsyncIterable<SessionEvent>; control: StreamController } {
  const queue: Array<{ value: SessionEvent } | { error: Error } | { done: true }> = [];
  let notify: (() => void) | undefined;

  const wake = () => {
    const fn = notify;
    notify = undefined;
    fn?.();
  };

  const control: StreamController = {
    push(event) {
      queue.push({ value: event });
      wake();
    },
    fail(error) {
      queue.push({ error });
      wake();
    },
    close() {
      queue.push({ done: true });
      wake();
    },
  };

  const iterable: AsyncIterable<SessionEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
          const item = queue.shift()!;
          if ("done" in item) return { done: true, value: undefined };
          if ("error" in item) throw item.error;
          return { done: false, value: item.value };
        },
      };
    },
  };

  return { iterable, control };
}

function makeSession(id: string, status: "idle" | "running" = "idle"): Session {
  return {
    id,
    status,
    usage: { models: {}, tools: {} },
  };
}

function makeFakeAgent(options?: {
  onEvents?: (sessionId: string, opts?: { after?: string; signal?: AbortSignal }) => AsyncIterable<SessionEvent>;
}) {
  const sent: SendRequest[] = [];
  const canceled: string[] = [];
  const compacted: Array<{ sessionId: string; instructions?: string }> = [];
  const updated: Array<{ sessionId: string; changes: unknown }> = [];
  const eventCalls: Array<{ sessionId: string; after?: string }> = [];
  let sessionCounter = 0;

  const info: AgentInfo = {
    name: "ops-agent",
    agent: { name: "ops", description: "Cloud ops agent" },
    commands: [{ name: "deploy", description: "Deploy service" }],
    tools: [{ name: "github", description: "GitHub API" }],
    models: [
      {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        thinkingLevels: ["off", "low", "medium", "high"],
      },
    ],
    defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
  };

  const agent: Agent = {
    async info() {
      return info;
    },
    async usage() {
      return { models: {}, tools: {} };
    },
    sessions: {
      async create() {
        sessionCounter += 1;
        return makeSession(`sess-${sessionCounter}`);
      },
      async get(sessionId) {
        return makeSession(sessionId);
      },
      async list() {
        return { data: [makeSession("sess-1")] };
      },
      async update(sessionId, changes) {
        updated.push({ sessionId, changes });
        return {
          ...makeSession(sessionId),
          ...(changes.title ? { title: changes.title } : {}),
          ...(changes.model ? { model: changes.model } : {}),
          ...(changes.thinkingLevel ? { thinkingLevel: changes.thinkingLevel } : {}),
        };
      },
      async delete() {},
      async entries() {
        return { data: [] };
      },
      events(sessionId, opts) {
        eventCalls.push({ sessionId, ...(opts?.after !== undefined ? { after: opts.after } : {}) });
        if (options?.onEvents) return options.onEvents(sessionId, opts);
        return createEventStream().iterable;
      },
      async cancel(sessionId) {
        canceled.push(sessionId);
        return { stopped: ["msg-1"] };
      },
      async compact(sessionId, opts) {
        compacted.push({ sessionId, ...(opts?.instructions ? { instructions: opts.instructions } : {}) });
      },
      async attachment() {
        return { mimeType: "image/png", data: new Uint8Array() };
      },
    },
    messages: {
      async send(req) {
        sent.push(req);
        return { id: `msg-${sent.length}`, sessionId: req.sessionId, status: "queued" };
      },
      async *stream() {},
      async get() {
        return { id: "msg-1", sessionId: "sess-1", status: "completed" };
      },
    },
    schedules: {
      async run(name) {
        return { status: "sent", message: { id: `sched-${name}`, sessionId: "sess-sched", status: "queued" } };
      },
      async list() {
        return [{ name: "daily", cron: "0 9 * * *" }];
      },
    },
    wakeups: {
      async cancel(id) {
        return { id, sessionId: "sess-1", fireAt: "2026-01-01T00:00:00Z", prompt: "check" };
      },
      async list() {
        return [];
      },
    },
  };

  return { agent, sent, canceled, compacted, updated, eventCalls };
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("remotes config", () => {
  it("returns empty remotes when config file does not exist", () => {
    const dir = makeTempDir();
    const loaded = loadRemotes({ path: join(dir, "missing.json") });
    expect(loaded.config).toEqual({ remotes: {} });
  });

  it("loads HTTP (default type) and AgentCore remotes and expands $ENV_VAR apiKey", async () => {
    const dir = makeTempDir();
    const cfgPath = join(dir, "remotes.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: "ops",
        remotes: {
          ops: { url: "http://127.0.0.1:4100", apiKey: "$OPS_KEY", sessionId: "sess-42" },
          bedrock: {
            type: "agentcore",
            runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_agent",
            sessionId: "a".repeat(33),
            qualifier: "prod",
          },
        },
      }),
    );

    const { config } = loadRemotes({ path: cfgPath });
    expect(config.default).toBe("ops");
    expect(config.remotes.ops).toEqual({
      type: "http",
      url: "http://127.0.0.1:4100",
      apiKey: "$OPS_KEY",
      sessionId: "sess-42",
    });
    expect(config.remotes.bedrock).toEqual({
      type: "agentcore",
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_agent",
      sessionId: "a".repeat(33),
      qualifier: "prod",
    });

    const connected = await connectRemote("ops", config.remotes.ops!, { OPS_KEY: "secret-token" });
    expect(connected.defaultSessionId).toBe("sess-42");

    await expect(connectRemote("ops", config.remotes.ops!, {})).rejects.toThrow(/Environment variable OPS_KEY/);
  });

  it("refuses malformed remote entries with an actionable message", () => {
    const dir = makeTempDir();
    const cfgPath = join(dir, "remotes.json");
    writeFileSync(cfgPath, JSON.stringify({ remotes: { broken: { type: "http" } } }));
    expect(() => loadRemotes({ path: cfgPath })).toThrow(/requires a non-empty "url"/);

    writeFileSync(cfgPath, JSON.stringify({ remotes: { bad: { type: "grpc", url: "http://localhost" } } }));
    expect(() => loadRemotes({ path: cfgPath })).toThrow(/unsupported type "grpc"/);

    writeFileSync(cfgPath, JSON.stringify({ remotes: { badUrl: { url: "not-a-url" } } }));
    expect(() => loadRemotes({ path: cfgPath })).toThrow(/invalid URL "not-a-url"/);

    expect(() => saveRemote("ftp-bad", { type: "http", url: "ftp://example.com" }, { path: cfgPath })).toThrow(
      /invalid URL "ftp:\/\/example\.com"/,
    );
  });

  it("saves and removes remotes with 0600 permissions and maintains default", () => {
    const dir = makeTempDir();
    const cfgPath = join(dir, "nested", "remotes.json");

    const first = saveRemote(
      "ops",
      { type: "http", url: "https://ops.example.com", apiKey: "$OPS_KEY" },
      { path: cfgPath },
    );
    expect(first.config.default).toBe("ops");
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);

    const second = saveRemote("staging", { type: "http", url: "https://staging.example.com" }, { path: cfgPath });
    expect(second.config.default).toBe("ops");
    expect(Object.keys(second.config.remotes)).toEqual(["ops", "staging"]);

    const afterRemove = removeRemote("ops", { path: cfgPath });
    expect(afterRemove.removed).toBe(true);
    expect(afterRemove.config.default).toBe("staging");
    expect(Object.keys(afterRemove.config.remotes)).toEqual(["staging"]);
  });
});

describe("RemoteController", () => {
  it("reduces streaming deltas, tools, entries, and done into view state", async () => {
    const stream = createEventStream();
    const { agent, sent } = makeFakeAgent({
      onEvents: () => stream.iterable,
    });
    const entries: Array<{ entry: Entry; replayed: boolean }> = [];
    const doneMessages: Message[] = [];

    const controller = new RemoteController(
      {
        onEntry: (entry, meta) => entries.push({ entry, replayed: meta.replayed }),
        onDone: (msg) => doneMessages.push(msg),
      },
      { sleep: async () => {} },
    );

    await controller.connect("ops", agent);
    stream.control.push({ type: "state", session: makeSession("sess-1", "running") });
    stream.control.push({ type: "delta", channel: "thinking", text: "planning " });
    stream.control.push({ type: "delta", channel: "text", text: "Hello " });
    stream.control.push({ type: "delta", channel: "text", text: "world" });
    stream.control.push({ type: "tool_started", toolCallId: "tc-1", name: "github", args: { repo: "a/b" } });
    stream.control.push({ type: "tool_progress", toolCallId: "tc-1", text: "creating PR..." });
    await flushMicrotasks();

    expect(controller.getState().liveReply).toEqual({ thinking: "planning ", text: "Hello world" });
    expect(controller.getState().activeTools).toEqual([
      { toolCallId: "tc-1", name: "github", args: { repo: "a/b" }, progress: "creating PR..." },
    ]);

    // Sending while running defaults to steer.
    await controller.send("adjust title");
    expect(sent[0]?.whenBusy).toBe("steer");

    const assistantEntry: Entry = {
      id: "e-1",
      timestamp: 1000,
      kind: "assistant",
      data: { text: "Hello world", usage: { inputTokens: 10, outputTokens: 5 } },
    };
    const toolResultEntry: Entry = {
      id: "e-2",
      timestamp: 1001,
      kind: "tool_result",
      data: { toolCallId: "tc-1", toolName: "github", isError: false, content: [{ type: "text", text: "PR #1" }] },
    };
    stream.control.push({ type: "entry", entry: assistantEntry });
    stream.control.push({ type: "entry", entry: toolResultEntry });
    stream.control.push({
      type: "done",
      message: {
        id: "msg-1",
        sessionId: "sess-1",
        status: "completed",
        answer: { entryId: "e-1", text: "Hello world" },
      },
    });
    await flushMicrotasks();

    expect(controller.getState().liveReply).toBeUndefined();
    expect(controller.getState().activeTools).toEqual([]);
    expect(controller.getState().session?.status).toBe("idle");
    expect(entries.map((e) => e.entry.id)).toEqual(["e-1", "e-2"]);
    expect(doneMessages).toHaveLength(1);

    controller.disconnect();
  });

  it("reconnects after a retryable stream_error from lastEntryId and deduplicates replayed entries", async () => {
    const streams = [createEventStream(), createEventStream()];
    let call = 0;
    const { agent, eventCalls } = makeFakeAgent({
      onEvents: () => streams[call++]!.iterable,
    });

    const received: string[] = [];
    const controller = new RemoteController({ onEntry: (entry) => received.push(entry.id) }, { sleep: async () => {} });

    await controller.connect("ops", agent);
    streams[0]!.control.push({ type: "state", session: makeSession("sess-1") });
    streams[0]!.control.push({
      type: "entry",
      entry: { id: "e-1", timestamp: 1, kind: "user", data: { content: [{ type: "text", text: "hi" }] } },
    });
    streams[0]!.control.push({
      type: "stream_error",
      error: { code: "unavailable", message: "transient drop", retryable: true },
    });
    await flushMicrotasks(12);

    expect(eventCalls).toEqual([
      { sessionId: "sess-1", after: "start" },
      { sessionId: "sess-1", after: "e-1" },
    ]);

    // Server replays e-1 again plus new e-2: e-1 must not be emitted twice.
    streams[1]!.control.push({
      type: "entry",
      entry: { id: "e-1", timestamp: 1, kind: "user", data: { content: [{ type: "text", text: "hi" }] } },
    });
    streams[1]!.control.push({
      type: "entry",
      entry: { id: "e-2", timestamp: 2, kind: "assistant", data: { text: "ok" } },
    });
    await flushMicrotasks();

    expect(received).toEqual(["e-1", "e-2"]);
    controller.disconnect();
  });

  it("stops reconnecting on fatal non-retryable stream errors", async () => {
    const stream = createEventStream();
    const { agent, eventCalls } = makeFakeAgent({
      onEvents: () => stream.iterable,
    });
    const errors: Error[] = [];

    const controller = new RemoteController({ onError: (err) => errors.push(err) }, { sleep: async () => {} });

    await controller.connect("ops", agent);
    stream.control.push({
      type: "stream_error",
      error: { code: "unauthorized", message: "invalid api key", retryable: false },
    });
    await flushMicrotasks(10);

    expect(eventCalls).toHaveLength(1);
    expect(controller.getState().status).toBe("disconnected");
    expect(errors[0]).toBeInstanceOf(AgentError);
    expect(errors[0]?.message).toContain("invalid api key");
  });

  it("ignores stale events from a previous session after switching sessions", async () => {
    const oldStream = createEventStream();
    const newStream = createEventStream();
    const { agent } = makeFakeAgent({
      onEvents: (sessionId) => (sessionId === "sess-1" ? oldStream.iterable : newStream.iterable),
    });
    const received: string[] = [];

    const controller = new RemoteController({ onEntry: (entry) => received.push(entry.id) }, { sleep: async () => {} });

    await controller.connect("ops", agent);
    await controller.switchSession("sess-2");

    // Late event arriving from old stream must be discarded.
    oldStream.control.push({
      type: "entry",
      entry: { id: "stale-entry", timestamp: 1, kind: "assistant", data: { text: "old" } },
    });
    newStream.control.push({
      type: "entry",
      entry: { id: "fresh-entry", timestamp: 2, kind: "assistant", data: { text: "new" } },
    });
    await flushMicrotasks();

    expect(received).toEqual(["fresh-entry"]);
    controller.disconnect();
  });

  it("keeps the existing session stream alive when switchSession fails", async () => {
    const stream = createEventStream();
    const { agent } = makeFakeAgent({
      onEvents: () => stream.iterable,
    });
    agent.sessions.get = async (id) => {
      if (id === "missing") throw new AgentError({ code: "not_found", message: "no such session", retryable: false });
      return makeSession(id);
    };

    const received: string[] = [];
    const controller = new RemoteController({ onEntry: (entry) => received.push(entry.id) }, { sleep: async () => {} });
    await controller.connect("ops", agent);

    await expect(controller.switchSession("missing")).rejects.toThrow(/no such session/);

    // Original session stream must still be active and delivering events.
    stream.control.push({
      type: "entry",
      entry: { id: "still-alive", timestamp: 3, kind: "assistant", data: { text: "ok" } },
    });
    await flushMicrotasks();

    expect(controller.getState().session?.id).toBe("sess-1");
    expect(received).toEqual(["still-alive"]);
    controller.disconnect();
  });

  it("refreshes session usage from server when a turn finishes", async () => {
    const stream = createEventStream();
    const { agent } = makeFakeAgent({
      onEvents: () => stream.iterable,
    });
    agent.sessions.get = async (id) => ({
      id,
      status: "idle",
      usage: { models: { "openai/gpt-6-luna": { inputTokens: 120, outputTokens: 45, cost: 0.012 } }, tools: {} },
    });

    const controller = new RemoteController({}, { sleep: async () => {} });
    await controller.connect("ops", agent);
    stream.control.push({
      type: "done",
      message: { id: "m-1", sessionId: "sess-1", status: "completed" },
    });
    await flushMicrotasks(10);

    expect(controller.getState().session?.usage.models["openai/gpt-6-luna"]).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cost: 0.012,
    });
    controller.disconnect();
  });

  it("does not overwrite newer running status when a stale done refresh resolves later", async () => {
    const stream = createEventStream();
    const { agent } = makeFakeAgent({
      onEvents: () => stream.iterable,
    });
    let resolveRefresh!: (session: Session) => void;
    agent.sessions.get = () =>
      new Promise<Session>((resolve) => {
        resolveRefresh = resolve;
      });

    const controller = new RemoteController({}, { sleep: async () => {} });
    await controller.connect("ops", agent);
    stream.control.push({
      type: "done",
      message: { id: "m-1", sessionId: "sess-1", status: "completed" },
    });
    await flushMicrotasks();

    // Next queued turn starts before the slow sessions.get() resolves.
    stream.control.push({ type: "delta", channel: "text", text: "next turn" });
    await flushMicrotasks();
    expect(controller.getState().session?.status).toBe("running");

    resolveRefresh({
      id: "sess-1",
      status: "idle",
      usage: { models: { "openai/gpt-6-luna": { inputTokens: 50, outputTokens: 20, cost: 0.005 } }, tools: {} },
    });
    await flushMicrotasks();

    // Status remains running while usage is still merged.
    expect(controller.getState().session?.status).toBe("running");
    expect(controller.getState().session?.usage.models["openai/gpt-6-luna"]?.outputTokens).toBe(20);
    controller.disconnect();
  });

  it("rejects connect and switchSession if superseded by disconnect while in flight", async () => {
    const { agent } = makeFakeAgent();
    let resolveGet!: (session: Session) => void;
    agent.sessions.get = () =>
      new Promise<Session>((resolve) => {
        resolveGet = resolve;
      });

    const controller = new RemoteController({}, { sleep: async () => {} });
    await controller.connect("ops", agent);

    const switchPromise = controller.switchSession("sess-2");
    await flushMicrotasks();
    controller.disconnect();
    resolveGet(makeSession("sess-2"));

    await expect(switchPromise).rejects.toThrow(/Session transition superseded/);
    expect(controller.getState().status).toBe("disconnected");
  });

  it("hydrates activeTools, queuedMessages, and compacting from state snapshot and handles compaction events", async () => {
    const stream = createEventStream();
    const deleted: string[] = [];
    const { agent } = makeFakeAgent({
      onEvents: () => stream.iterable,
    });
    agent.sessions.delete = async (id) => {
      deleted.push(id);
    };
    const errors: Error[] = [];
    const controller = new RemoteController({ onError: (err) => errors.push(err) }, { sleep: async () => {} });

    await controller.connect("ops", agent);
    stream.control.push({
      type: "state",
      session: {
        ...makeSession("sess-1", "running"),
        title: "Investigate prod",
        activeTools: [{ toolCallId: "tc-9", name: "bash", status: "running", progress: "running tests" }],
        queuedMessages: [{ id: "m-2", mode: "queue" }],
        compacting: true,
      },
    });
    await flushMicrotasks();

    expect(controller.getState().activeTools).toEqual([
      { toolCallId: "tc-9", name: "bash", progress: "running tests" },
    ]);
    expect(controller.getState().queuedMessages).toEqual([{ id: "m-2", mode: "queue" }]);
    expect(controller.getState().compacting).toBe(true);

    stream.control.push({
      type: "tool_progress",
      toolCallId: "tc-9",
      text: "line 2",
      output: "line 1\nline 2",
    });
    stream.control.push({ type: "compaction_failed", error: "provider timeout" });
    await flushMicrotasks();

    expect(controller.getState().activeTools[0]?.output).toBe("line 1\nline 2");
    expect(controller.getState().compacting).toBe(false);
    expect(errors[0]?.message).toContain("provider timeout");

    stream.control.push({ type: "compaction_started", trigger: "manual" });
    await flushMicrotasks();
    expect(controller.getState().compacting).toBe(true);

    stream.control.push({
      type: "entry",
      entry: { id: "e-c", timestamp: 5, kind: "compaction", data: { summary: "condensed" } },
    });
    await flushMicrotasks();
    expect(controller.getState().compacting).toBe(false);

    await controller.deleteSession("sess-1");
    expect(deleted).toEqual(["sess-1"]);
    expect(controller.getState().status).toBe("disconnected");
  });

  it("tracks queuedMessages live when send() returns queued and removes them when placed or canceled", async () => {
    const stream = createEventStream();
    const { agent } = makeFakeAgent({
      onEvents: () => stream.iterable,
    });
    const controller = new RemoteController({}, { sleep: async () => {} });
    await controller.connect("ops", agent);
    stream.control.push({ type: "state", session: makeSession("sess-1", "running") });
    await flushMicrotasks();

    const msg = await controller.send("follow up", { whenBusy: "queue" });
    expect(controller.getState().queuedMessages).toEqual([{ id: msg.id, mode: "queue" }]);

    stream.control.push({
      type: "entry",
      entry: {
        id: "e-q",
        timestamp: 10,
        kind: "user",
        data: { content: [{ type: "text", text: "follow up" }], messageId: msg.id },
      },
    });
    await flushMicrotasks();
    expect(controller.getState().queuedMessages).toEqual([]);

    // Live state push updates title and contextUsage in place.
    stream.control.push({
      type: "state",
      session: {
        ...makeSession("sess-1", "idle"),
        title: "Synced title",
        contextUsage: { tokens: 50_000, contextWindow: 200_000 },
      },
    });
    await flushMicrotasks();
    expect(controller.getState().session?.title).toBe("Synced title");
    expect(controller.getState().session?.contextUsage).toEqual({ tokens: 50_000, contextWindow: 200_000 });
    controller.disconnect();
  });

  it("builds text and image ContentParts for send", () => {
    expect(buildSendContent("hello")).toBe("hello");
    expect(buildSendContent("check this", [{ mimeType: "image/png", data: "abc" }])).toEqual([
      { type: "text", text: "check this" },
      { type: "image", mimeType: "image/png", data: "abc" },
    ]);
  });
});

describe("TerminalStatusReporter", () => {
  it("deduplicates OSC 7501 reports and notifies cmux only on done/error", () => {
    const writes: string[] = [];
    const cmuxCalls: Array<{ state: string; message?: string }> = [];
    const reporter = new TerminalStatusReporter({
      write: (seq) => writes.push(seq),
      notifyCmux: (state, message) => cmuxCalls.push({ state, ...(message ? { message } : {}) }),
    });

    reporter.report("working", "ops");
    reporter.report("working", "ops");
    reporter.report("done", "ops");
    reporter.report("error", "boom");
    reporter.clear();

    expect(writes).toHaveLength(4);
    expect(writes[0]).toContain("7501");
    expect(cmuxCalls).toEqual([
      { state: "done", message: "ops" },
      { state: "error", message: "boom" },
    ]);
  });
});

describe("Pi extension host integration", () => {
  function createMockPi() {
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const commands = new Map<string, any>();
    const flags = new Map<string, any>();
    const entryRenderers = new Map<string, any>();
    const appendedEntries: Array<{ customType: string; data: unknown }> = [];
    const notifications: Array<{ message: string; type?: string }> = [];
    const widgets = new Map<string, unknown>();
    let footer: unknown;
    let footerSetCount = 0;
    let autocompleteCount = 0;
    let terminalListener: ((data: string) => any) | undefined;

    const pi: any = {
      on(event: string, handler: (...args: any[]) => any) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerCommand(name: string, spec: any) {
        commands.set(name, spec);
      },
      registerFlag(name: string, spec: any) {
        flags.set(name, spec);
      },
      getFlag() {
        return undefined;
      },
      registerEntryRenderer(type: string, renderer: any) {
        entryRenderers.set(type, renderer);
      },
      appendEntry(customType: string, data: unknown) {
        appendedEntries.push({ customType, data });
      },
    };

    const ctx: any = {
      mode: "tui",
      hasUI: true,
      ui: {
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
        input: async () => undefined,
        confirm: async () => true,
        select: async (_title: string, options: string[]) => options[0],
        setWidget(key: string, content: unknown) {
          if (content === undefined) widgets.delete(key);
          else widgets.set(key, content);
        },
        setFooter(factory: unknown) {
          footer = factory;
          if (factory !== undefined) footerSetCount += 1;
        },
        setStatus() {},
        addAutocompleteProvider() {
          autocompleteCount += 1;
        },
        onTerminalInput(fn: (data: string) => any) {
          terminalListener = fn;
          return () => {
            terminalListener = undefined;
          };
        },
      },
    };

    return {
      pi,
      ctx,
      handlers,
      commands,
      flags,
      entryRenderers,
      appendedEntries,
      notifications,
      widgets,
      getFooter: () => footer,
      getFooterSetCount: () => footerSetCount,
      getAutocompleteCount: () => autocompleteCount,
      sendTerminalInput: (data: string) => terminalListener?.(data),
    };
  }

  it("passes input through locally when disconnected, and registers /fa command, flag, and entry renderer", async () => {
    const mock = createMockPi();
    registerFastAgentRemoteExtension(mock.pi);

    expect(mock.commands.has("fa")).toBe(true);
    expect(mock.flags.has("fa")).toBe(true);
    expect(mock.entryRenderers.has(REMOTE_ENTRY_TYPE)).toBe(true);

    const inputHandler = mock.handlers.get("input")![0]!;
    const res = await inputHandler({ text: "hello local", source: "interactive" }, mock.ctx);
    expect(res).toEqual({ action: "continue" });
  });

  it("connects to a loopback FastAgent HTTP server, intercepts input, cancels on Esc, and disconnects cleanly", async () => {
    const { createServer } = await import("node:http");
    const dir = makeTempDir();
    const sentPayloads: Array<{ path: string; body: unknown }> = [];
    const canceledSessions: string[] = [];
    const compactedSessions: string[] = [];
    const deletedSessions: string[] = [];

    const server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer test-key") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unauthorized", message: "bad key", retryable: false } }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const body = bodyText ? JSON.parse(bodyText) : null;
        const url = new URL(req.url!, "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/v1/agent") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              name: "cloud-ops",
              agent: { name: "ops" },
              commands: [{ name: "deploy", description: "Deploy" }],
              tools: [],
              models: [{ provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevels: ["off", "high"] }],
            }),
          );
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/sessions") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify(makeSession("sess-live")));
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/sessions/sess-live") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(makeSession("sess-live")));
          return;
        }
        if (req.method === "PATCH" && url.pathname === "/v1/sessions/sess-live") {
          const title = (body as { title?: string | null } | null)?.title;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...makeSession("sess-live"), ...(title ? { title } : {}) }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/sessions") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              data: [makeSession("ml3sHksQuVE.25"), makeSession("ml3sHksQuVE.3")],
            }),
          );
          return;
        }
        if (req.method === "DELETE" && url.pathname.startsWith("/v1/sessions/")) {
          deletedSessions.push(url.pathname.slice("/v1/sessions/".length));
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/sessions/sess-live/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write(
            `event: state\ndata: ${JSON.stringify({ type: "state", session: makeSession("sess-live", "running") })}\n\n`,
          );
          res.write(
            `event: entry\ndata: ${JSON.stringify({
              type: "entry",
              entry: { id: "e-live-1", timestamp: 100, kind: "assistant", data: { text: "Remote reply" } },
            })}\n\n`,
          );
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/sessions/sess-live/messages") {
          sentPayloads.push({ path: url.pathname, body });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "m-1", sessionId: "sess-live", status: "queued" }));
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/sessions/sess-live/cancel") {
          canceledSessions.push("sess-live");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ stopped: ["m-1"] }));
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/sessions/sess-live/compact") {
          compactedSessions.push("sess-live");
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found", message: "not found", retryable: false } }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const prevPath = process.env.FASTAGENT_REMOTES_PATH;
    const cfgPath = join(dir, "remotes.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: "ops",
        remotes: { ops: { url: `http://127.0.0.1:${port}`, apiKey: "test-key" } },
      }),
    );
    process.env.FASTAGENT_REMOTES_PATH = cfgPath;

    try {
      const mock = createMockPi();
      registerFastAgentRemoteExtension(mock.pi);
      const fa = mock.commands.get("fa")!;
      await fa.handler("connect ops", mock.ctx);

      await waitFor(() => mock.appendedEntries.some((entry) => entry.customType === REMOTE_ENTRY_TYPE));

      expect(mock.getFooter()).toBeDefined();
      const remoteEntries = mock.appendedEntries.filter((entry) => entry.customType === REMOTE_ENTRY_TYPE);
      expect(remoteEntries).toHaveLength(1);
      // Persisted remote binding must not contain raw API keys.
      const bindings = mock.appendedEntries.filter((entry) => entry.customType === "fastagent-remote-binding");
      expect(bindings).toEqual([
        { customType: "fastagent-remote-binding", data: { remoteName: "ops", sessionId: "sess-live" } },
      ]);

      // Re-entering session_start (e.g. after local /new) must re-mount footer and autocomplete.
      const beforeFooterCount = mock.getFooterSetCount();
      const beforeAutocompleteCount = mock.getAutocompleteCount();
      const sessionStart = mock.handlers.get("session_start")![0]!;
      await sessionStart({ type: "session_start", reason: "new" }, mock.ctx);
      expect(mock.getFooterSetCount()).toBeGreaterThan(beforeFooterCount);
      expect(mock.getAutocompleteCount()).toBeGreaterThan(beforeAutocompleteCount);

      // User input is intercepted and forwarded to remote agent.
      const inputHandler = mock.handlers.get("input")![0]!;
      const result = await inputHandler({ text: "ship it", source: "interactive" }, mock.ctx);
      expect(result).toEqual({ action: "handled" });
      expect(sentPayloads).toHaveLength(1);
      expect((sentPayloads[0]!.body as { content: string }).content).toBe("ship it");

      // Esc while running triggers remote cancel.
      const escResult = mock.sendTerminalInput("\x1b");
      expect(escResult).toEqual({ consume: true });
      await waitFor(() => canceledSessions.length >= 1);
      expect(canceledSessions).toEqual(["sess-live"]);

      // /compact is intercepted and forwarded to remote compact.
      const compactHandler = mock.handlers.get("session_before_compact")![0]!;
      const compactRes = await compactHandler({ customInstructions: "keep PR links" }, mock.ctx);
      expect(compactRes).toEqual({ cancel: true });
      expect(compactedSessions).toEqual(["sess-live"]);

      // /fa title updates the remote session title.
      await fa.handler("title Deploy review", mock.ctx);
      expect(mock.notifications.at(-1)?.message).toContain("Deploy review");

      // /tree is blocked while connected.
      const treeHandler = mock.handlers.get("session_before_tree")![0]!;
      expect(treeHandler({}, mock.ctx)).toEqual({ cancel: true });

      // Disconnect restores local Pi state.
      await fa.handler("disconnect", mock.ctx);
      expect(mock.getFooter()).toBeUndefined();
      expect(mock.widgets.size).toBe(0);
      expect(await inputHandler({ text: "back to local", source: "interactive" }, mock.ctx)).toEqual({
        action: "continue",
      });

      // Direct URL connect works without any saved remotes.json.
      process.env.FASTAGENT_REMOTES_PATH = join(dir, "empty-remotes.json");
      await fa.handler(`connect http://127.0.0.1:${port} test-key`, mock.ctx);
      expect(mock.getFooter()).toBeDefined();
      await fa.handler("disconnect", mock.ctx);

      // /fa connect with no saved remotes guides interactive add and connects.
      const answers = ["my-cloud", `http://127.0.0.1:${port}`, "test-key"];
      mock.ctx.ui.input = async () => answers.shift();
      await fa.handler("connect", mock.ctx);
      expect(mock.getFooter()).toBeDefined();
      expect(loadRemotes({ path: join(dir, "empty-remotes.json") }).config.remotes["my-cloud"]).toEqual({
        type: "http",
        url: `http://127.0.0.1:${port}`,
        apiKey: "test-key",
      });
      await fa.handler("disconnect", mock.ctx);
      // /fa add with name and url (2 args) still prompts for optional API key.
      let keyPrompted = false;
      mock.ctx.ui.input = async () => {
        keyPrompted = true;
        return "test-key";
      };
      await fa.handler(`add two-arg http://127.0.0.1:${port}`, mock.ctx);
      expect(keyPrompted).toBe(true);
      expect(loadRemotes({ path: join(dir, "empty-remotes.json") }).config.remotes["two-arg"]?.type).toBe("http");
      await fa.handler("disconnect", mock.ctx);

      // /fa new triggers ctx.newSession() handoff cleanly without recursion or 404 errors.
      let newSessionCalls = 0;
      mock.ctx.newSession = async (opts: any) => {
        newSessionCalls += 1;
        await opts?.setup?.({ appendCustomEntry() {} });
        await sessionStart({ type: "session_start", reason: "new" }, mock.ctx);
        return { cancelled: false };
      };
      await fa.handler("connect two-arg", mock.ctx);
      const errorsBeforeNew = mock.notifications.filter((n) => n.type === "error").length;
      await fa.handler("new", mock.ctx);
      expect(newSessionCalls).toBe(1);
      expect(mock.notifications.filter((n) => n.type === "error").length).toBe(errorsBeforeNew);
      expect(mock.getFooter()).toBeDefined();
      await fa.handler("disconnect", mock.ctx);

      // --fa startup flag only auto-connects on reason === "startup", never on local /new after disconnect.
      mock.pi.getFlag = (name: string) => (name === "fa" ? "two-arg" : undefined);
      await sessionStart({ type: "session_start", reason: "new" }, mock.ctx);
      expect(mock.getFooter()).toBeUndefined();
      await sessionStart({ type: "session_start", reason: "startup" }, mock.ctx);
      expect(mock.getFooter()).toBeDefined();

      // Interactive /fa delete with shared FastAgent incarnation prefix must delete the selected second session, not index 0.
      mock.ctx.ui.select = async (_title: string, options: string[]) => options[1];
      await fa.handler("delete", mock.ctx);
      expect(deletedSessions).toEqual(["ml3sHksQuVE.3"]);
      expect(mock.getFooter()).toBeDefined();

      await fa.handler("delete sess-live", mock.ctx);
      expect(deletedSessions).toEqual(["ml3sHksQuVE.3", "sess-live"]);
      expect(mock.getFooter()).toBeUndefined();
    } finally {
      if (prevPath === undefined) delete process.env.FASTAGENT_REMOTES_PATH;
      else process.env.FASTAGENT_REMOTES_PATH = prevPath;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
