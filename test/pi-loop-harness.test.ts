/**
 * The SPEC v1 suite against pi-coding-agent through `LoopPort`, on real pi sessions over a record store on disk. What a
 * run does is chosen by its message, as the suite asks: the faux model answers the newest user message, `hold` and
 * `effect` call tools of those names first, and `fail` is an error the model returns.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type FauxResponseStep,
  Type,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piLoopHarness } from "../src/harnesses/pi/loop-harness.ts";
import { isRunMarker } from "../src/harnesses/pi/session-markers.ts";
import {
  type PiSessionRecordStore,
  piInMemorySessionRecordStore,
  piSessionRecordStore,
} from "../src/harnesses/pi/session-store.ts";
import type { MountedTool } from "../src/harnesses/pi/tool.ts";
import { log } from "../src/log.ts";
import { loopPort } from "../src/loop-port.ts";
import { type Agent, type InvokeEvent, LIMITS } from "../src/protocol.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { fauxAgent } from "./agent.ts";
import { makeFaux } from "./faux.ts";
import { collect, RunNotCompleted } from "../src/protocol-collect.ts";
import { defineTool, z } from "../src/pi.ts";
import { describeProtocolConformance } from "./protocol-conformance.ts";

type Message = { role: string; content: unknown };

const textOf = (message: Message | undefined): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .filter((block: { type?: string }) => block.type === "text")
        .map((block: { text: string }) => block.text)
        .join("")
    : "";
};

let calls = 0;
/** The answer to the newest user message; a tool call first for `hold` and `effect`, unless its result is in. */
const answer: FauxResponseStep = (context): AssistantMessage => {
  const messages = context.messages as Message[];
  const last = messages.at(-1);
  const user = [...messages].reverse().find((m) => m.role === "user");
  const text = textOf(user);
  if (last?.role === "user" && (text === "hold" || text === "effect")) {
    return fauxAssistantMessage(fauxToolCall(text, {}, { id: `call-${++calls}` }));
  }
  if (text === "fail") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request 400" });
  return fauxAssistantMessage(`answer: ${text}`);
};

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** One process's world: what its `hold` tool waits for, and how many times `effect` has run. */
class World {
  held = gate();
  /** Opened when a `hold` tool starts: its run is bound to pi and past its first model call. */
  holding = gate();
  effects = 0;
}

function tools(world: World): MountedTool[] {
  const parameters = Type.Object({});
  return [
    {
      name: "hold",
      label: "hold",
      description: "waits until released",
      parameters,
      async execute(_id, _params, signal) {
        world.holding.open();
        await Promise.race([
          world.held.opened,
          new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
        ]);
        return { content: [{ type: "text", text: "held" }], details: {} };
      },
    },
    {
      name: "effect",
      label: "effect",
      description: "has an effect",
      parameters,
      async execute() {
        world.effects++;
        return { content: [{ type: "text", text: "done" }], details: {} };
      },
    },
  ];
}

async function piAgent(
  sessions: PiSessionRecordStore,
  world: World,
  capacity: number = LIMITS.inFlightPerProcess,
  extensionPaths: string[] = [],
  catalog?: () => Promise<ModelRuntime>,
): Promise<Agent> {
  const { faux } = makeFaux({ models: [{ id: "first" }, { id: "second" }] });
  faux.setResponses(Array.from({ length: 2000 }, () => answer));
  const model = faux.getModel();
  const createModelRuntime = async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    return runtime;
  };
  const registry = await createModelRuntime();
  const cwd = process.cwd();
  const harness = piLoopHarness({
    sessions,
    createModelRuntime,
    modelSpec: `${model.provider}/${model.id}`,
    thinkingLevel: "off",
    tools: tools(world),
    readDefinition: () => ({ systemPrompt: "test", skills: [] }),
    extensionPaths: async () => extensionPaths,
    cwd,
    catalog: catalog ?? (async () => registry),
  });
  return servingAgent(loopPort(harness, { queuedPerSession: LIMITS.queuedPerSession, inFlightPerProcess: capacity }));
}

let sessions: PiSessionRecordStore;
let world = new World();

describeProtocolConformance("pi-coding-agent through LoopPort", {
  start: async ({ capacity } = {}) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-loop-"));
    sessions = piSessionRecordStore({ dir, cwd: process.cwd() });
    world = new World();
    return piAgent(sessions, world, capacity);
  },
  // The previous process's runs never move again: its `hold` waits on a gate nothing opens.
  restart: async () => {
    const effects = world.effects;
    world = new World();
    world.effects = effects;
    return piAgent(sessions, world);
  },
  release: () => world.held.open(),
  effects: () => world.effects,
});

async function receiptOf(events: AsyncIterable<InvokeEvent>) {
  for await (const event of events) if (event.type === "accepted") return event;
  throw new Error("not accepted");
}

/**
 * An extension whose `input` handler consumes `handle` (and counts it), and holds `slow` until `release-slow` is
 * written to a file the test controls, so that message reaches pi's queue only after the run it joined settled.
 */
async function extensionDir(): Promise<{ dir: string; paths: string[]; counted: () => Promise<number> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-loop-ext-"));
  const path = join(dir, "steering.ts");
  await writeFile(
    path,
    `import { existsSync, writeFileSync, readFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
export default function (pi) {
  pi.on("input", async (event) => {
    if (event.text === "slow-handle") while (!existsSync(dir + "/release-slow")) await new Promise((r) => setTimeout(r, 5));
    if (event.text === "handle" || event.text === "slow-handle") {
      const file = dir + "/handled";
      writeFileSync(file, String(Number(existsSync(file) ? readFileSync(file, "utf8") : "0") + 1));
      return { action: "handled" };
    }
    if (event.text === "slow") while (!existsSync(dir + "/release-slow")) await new Promise((r) => setTimeout(r, 5));
    return undefined;
  });
}
`,
  );
  const { readFile } = await import("node:fs/promises");
  return {
    dir,
    paths: [path],
    counted: async () => Number(await readFile(join(dir, "handled"), "utf8").catch(() => "0")),
  };
}

describe("pi-coding-agent through LoopPort", () => {
  it("a run on a provider with no credential fails auth_required", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    try {
      const createModelRuntime = () => ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
      const catalog = await createModelRuntime();
      const model = catalog.getModels("anthropic")[0];
      if (!model) throw new Error("pi's catalog has no anthropic model");
      const store = piSessionRecordStore({ dir: await mkdtemp(join(tmpdir(), "pi-loop-")), cwd: process.cwd() });
      const agent = servingAgent(
        loopPort(
          piLoopHarness({
            sessions: store,
            createModelRuntime,
            modelSpec: `${model.provider}/${model.id}`,
            readDefinition: () => ({ systemPrompt: "test", skills: [] }),
            cwd: process.cwd(),
            catalog: async () => catalog,
          }),
        ),
      );
      const first = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hi" } }));
      const run = await vi.waitFor(
        async () => {
          const status = await agent.sessions.get("s").runs.get({ runId: first.run.runId });
          if (status?.status !== "done") throw new Error("not done");
          return status;
        },
        { timeout: 5000 },
      );
      expect(run).toMatchObject({ outcome: { status: "failed", error: { code: "auth_required", retryable: false } } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a steer an extension consumed is not run again", async () => {
    const ext = await extensionDir();
    const local = new World();
    const store = piSessionRecordStore({ dir: await mkdtemp(join(tmpdir(), "pi-loop-")), cwd: process.cwd() });
    const agent = await piAgent(store, local, LIMITS.inFlightPerProcess, ext.paths);
    const session = agent.sessions.get("s");
    const first = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }));
    await vi.waitFor(async () => expect((await session.runs.get({ runId: first.run.runId }))?.status).toBe("running"), {
      timeout: 5000,
    });
    await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "handle" }, whenBusy: "steer" }));
    local.held.open();
    const run = await vi.waitFor(
      async () => {
        const status = await session.runs.get({ runId: first.run.runId });
        if (status?.status !== "done") throw new Error("not done");
        return status;
      },
      { timeout: 5000 },
    );
    expect(await ext.counted()).toBe(1);
    expect(run).toMatchObject({ outcome: { status: "completed" }, answer: { text: "answer: hold" } });
    expect(run.messages.map((m) => m.entryId !== undefined)).toEqual([true, false]);
  });

  it("a steer consumed only after its run settled is still not run again", async () => {
    const ext = await extensionDir();
    const local = new World();
    const store = piSessionRecordStore({ dir: await mkdtemp(join(tmpdir(), "pi-loop-")), cwd: process.cwd() });
    const agent = await piAgent(store, local, LIMITS.inFlightPerProcess, ext.paths);
    const session = agent.sessions.get("s");
    const first = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }));
    await vi.waitFor(async () => expect((await session.runs.get({ runId: first.run.runId }))?.status).toBe("running"), {
      timeout: 5000,
    });
    await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "slow-handle" }, whenBusy: "steer" }));
    local.held.open();
    await vi.waitFor(
      async () => {
        const page = await session.read();
        const answers = page.ok ? page.entries.filter((e) => e.kind === "assistant_message") : [];
        expect(answers.map((e) => (e.data as { text: string }).text)).toContain("answer: hold");
      },
      { timeout: 5000 },
    );
    await writeFile(join(ext.dir, "release-slow"), "");
    const run = await vi.waitFor(
      async () => {
        const status = await session.runs.get({ runId: first.run.runId });
        if (status?.status !== "done") throw new Error("not done");
        return status;
      },
      { timeout: 5000 },
    );
    expect(await ext.counted()).toBe(1);
    expect(run.messages.map((m) => m.entryId !== undefined)).toEqual([true, false]);
  });

  it("a steer that reaches pi after its run settled is run in the same run", async () => {
    const ext = await extensionDir();
    const local = new World();
    const store = piSessionRecordStore({ dir: await mkdtemp(join(tmpdir(), "pi-loop-")), cwd: process.cwd() });
    const agent = await piAgent(store, local, LIMITS.inFlightPerProcess, ext.paths);
    const session = agent.sessions.get("s");
    const first = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }));
    await vi.waitFor(async () => expect((await session.runs.get({ runId: first.run.runId }))?.status).toBe("running"), {
      timeout: 5000,
    });
    await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "slow" }, whenBusy: "steer" }));
    local.held.open();
    // The run answers `hold` and settles while `slow` is still in its input handler.
    await vi.waitFor(
      async () => {
        const page = await session.read();
        const answers = page.ok ? page.entries.filter((e) => e.kind === "assistant_message") : [];
        expect(answers.map((e) => (e.data as { text: string }).text)).toContain("answer: hold");
      },
      { timeout: 5000 },
    );
    await writeFile(join(ext.dir, "release-slow"), "");
    const run = await vi.waitFor(
      async () => {
        const status = await session.runs.get({ runId: first.run.runId });
        if (status?.status !== "done") throw new Error("not done");
        return status;
      },
      { timeout: 5000 },
    );
    expect(run).toMatchObject({ outcome: { status: "completed" }, answer: { text: "answer: slow" } });
    expect(run.messages.map((m) => m.entryId !== undefined)).toEqual([true, true]);
    const page = await session.read();
    expect(page.ok ? page.entries.filter((e) => e.kind === "run_ended") : []).toHaveLength(1);
  });

  it("keeps run markers out of the model's context and out of a fork's history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-loop-"));
    const store = piSessionRecordStore({ dir, cwd: process.cwd() });
    const agent = await piAgent(store, new World());
    for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "one" } })) void _;
    for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "two" } })) void _;
    const record = await store.openIfExists("s");
    const context = record?.buildSessionContext().messages.map((m) => m.role);
    expect(context).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(await agent.sessions.create({ sessionId: "f", fork: { sessionId: "s" } })).toMatchObject({ ok: true });
    const forked = await store.openIfExists("f");
    expect(forked?.getEntries().filter(isRunMarker)).toEqual([]);
  });

  it("a model set during a run is written at once, and the next run runs on it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-loop-"));
    const store = piSessionRecordStore({ dir, cwd: process.cwd() });
    const local = new World();
    const agent = await piAgent(store, local);
    const session = agent.sessions.get("s");
    const first = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }));
    await local.holding.opened;
    expect(await session.update({ model: "faux/second" })).toEqual({ ok: true });
    expect(await session.read({ limit: 0 })).toMatchObject({
      ok: true,
      state: { model: "faux/second", status: "running" },
    });
    local.held.open();
    await vi.waitFor(
      async () =>
        expect(await session.runs.get({ runId: first.run.runId })).toMatchObject({ outcome: { status: "completed" } }),
      { timeout: 5000 },
    );
    for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "next" } })) void _;
    const record = await store.openIfExists("s");
    const answeredBy = (record?.getEntries() ?? []).flatMap((e) =>
      e.type === "message" && e.message.role === "assistant" ? [e.message.model] : [],
    );
    // The running run keeps the model it started on, through its tool call and its answer.
    expect(answeredBy).toEqual(["first", "first", "second"]);
  });

  it("a registry that cannot be built leaves the model out of state, and refuses a model it cannot check", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = piSessionRecordStore({ dir: await mkdtemp(join(tmpdir(), "pi-loop-")), cwd: process.cwd() });
      const agent = await piAgent(store, new World(), undefined, [], async () => {
        throw new Error("extensions/ unreadable");
      });
      expect(await agent.sessions.create({ sessionId: "s" })).toEqual({ ok: true, sessionId: "s" });
      const read = await agent.sessions.get("s").read({ limit: 0 });
      expect(read.ok && read.state.model).toBe(undefined);
      expect(await agent.sessions.get("s").update({ model: "faux/first" })).toMatchObject({
        ok: false,
        error: { code: "unavailable" },
      });
      expect(await agent.sessions.get("s").update({ name: "still nameable" })).toEqual({ ok: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("a record whose entry chain is cut stays readable, without the settings that chain decides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-loop-"));
    const store = piSessionRecordStore({ dir, cwd: process.cwd() });
    const first = await piAgent(store, new World());
    for await (const _ of first.invoke({ sessionId: "s", prompt: { text: "one" } })) {
    }
    const [file] = (await readdir(dir, { recursive: true })).filter((name) => String(name).endsWith(".jsonl"));
    const path = join(dir, String(file));
    const [header, , ...rest] = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, `${[header, ...rest].join("\n")}\n`); // the first entry is gone; its child's parent with it
    const reopened = await piAgent(store, new World());
    const read = await reopened.sessions.get("s").read({ limit: 0 });
    expect(read.ok).toBe(true);
    expect(read.ok && read.state.model).toBe(undefined);
  });

  it("a `recent` fork gives the model a window of the copy; a plain fork gives it all", async () => {
    const store = piInMemorySessionRecordStore();
    const room = await store.openOrCreate("room");
    for (let i = 0; i < 60; i++) {
      room.appendMessage({ role: "user", content: `q${i}`, timestamp: i });
      room.appendMessage(fauxAssistantMessage(`a${i}`));
    }
    const agent = await piAgent(store, new World());
    const compactions = async (sessionId: string) => {
      const page = await agent.sessions.get(sessionId).read({ limit: LIMITS.readMax });
      return page.ok ? page.entries.filter((e) => e.kind === "compaction").length : -1;
    };
    expect(
      await agent.sessions.create({ sessionId: "thread", fork: { sessionId: "room", context: "recent" } }),
    ).toEqual({ ok: true, sessionId: "thread" });
    expect(await agent.sessions.create({ sessionId: "copy", fork: { sessionId: "room" } })).toEqual({
      ok: true,
      sessionId: "copy",
    });
    expect(await compactions("thread")).toBe(1);
    expect(await compactions("copy")).toBe(0);
  });
});

describe("pi's auto-retry vs. append-only deltas", () => {
  it("a failure AFTER output was streamed is final: a retry would concatenate two answers", async () => {
    const { agent } = fauxAgent([
      fauxAssistantMessage("the first half of a wrong", { stopReason: "error", errorMessage: "boom 500" }),
      fauxAssistantMessage("a complete replacement answer"),
    ]);
    const started = Date.now();
    await expect(
      collect(agent.invoke({ sessionId: "streamed-then-failed", prompt: { text: "go" } })),
    ).rejects.toBeInstanceOf(RunNotCompleted);
    // Refusing the retry must also CANCEL it: pi's first backoff is 2s, and letting it run would both delay the
    // failure and spend a provider call on an answer this run can never use.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a failure BEFORE any output still retries: that window is free resilience", async () => {
    const { agent } = fauxAgent([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom 500" }),
      fauxAssistantMessage("the answer, second attempt"),
    ]);
    const { text } = await collect(agent.invoke({ sessionId: "silent-then-retried", prompt: { text: "go" } }));
    expect(text).toBe("the answer, second attempt");
  });

  it("an executed tool does not close the window: the retry resumes from it instead of re-running it", async () => {
    let toolRuns = 0;
    const ping = defineTool({
      name: "ping",
      description: "A tool with a side effect worth not repeating.",
      input: z.object({}),
      execute: () => {
        toolRuns++;
        return "pong";
      },
    });
    const { agent } = fauxAgent(
      [
        fauxAssistantMessage(fauxToolCall("ping", {}, { id: "call-1" })),
        // The request that follows the tool fails before saying anything. pi retries it against the PERSISTED tool
        // result; refusing here would hand the retry to the caller, who cannot re-ask without running the tool again.
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom 500" }),
        fauxAssistantMessage("pong, once"),
      ],
      { tools: [ping] },
    );
    const { text } = await collect(agent.invoke({ sessionId: "tool-then-retried", prompt: { text: "go" } }));
    expect(text).toBe("pong, once");
    expect(toolRuns).toBe(1);
  });
});

describe("an abort right after acceptance", () => {
  // pi's abort stops only an agent run in flight; one sent before the first request (while prompt() prepares) must
  // still stop it (#691). This response answers only an aborted signal, so a missed abort never settles.
  const untilAborted: FauxResponseStep = (_context, options) =>
    new Promise((resolve) => {
      const aborted = () => resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" }));
      if (options?.signal?.aborted) return aborted();
      options?.signal?.addEventListener("abort", aborted, { once: true });
    });

  /** Start a run, abort its session once it is accepted (after `wait`), and answer how the run ended. */
  async function abortedAfter(agent: Agent, sessionId: string, wait: () => Promise<void>) {
    const iterator = agent.invoke({ sessionId, prompt: { text: "go" } })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "accepted" });
    await wait();
    expect(await agent.sessions.get(sessionId).abort()).toMatchObject({ ok: true });
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("the stream ended without its run_ended");
      const event = next.value;
      if (event.type === "entry" && event.entry.kind === "run_ended")
        return (event.entry.data as { outcome: unknown }).outcome;
    }
  }

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["synchronously", async () => {}],
    ["after a microtask", () => Promise.resolve()],
    ["after setImmediate", () => new Promise<void>((r) => setImmediate(r))],
  ])("stops the first request when sent %s", async (_when, wait) => {
    const { agent } = fauxAgent([untilAborted]);
    expect(await abortedAfter(agent, "sEarly", wait)).toEqual({ status: "canceled", by: "abort" });
  });

  it("also stops the automatic compaction prompt() runs before the first agent run", async () => {
    const home = await mkdtemp(join(tmpdir(), "fa-early-abort-home-"));
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({
        compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 400 },
        retry: { enabled: false },
      }),
    );
    vi.stubEnv("HOME", home);
    const debug = vi.spyOn(log, "debug");
    try {
      const { agent, sessions, faux } = fauxAgent([untilAborted, untilAborted], {
        faux: { models: [{ id: "small", contextWindow: 2500, maxTokens: 1000 }] },
      });
      // History whose last answer filled the context window: prompt() compacts before it starts the agent run.
      const record = await sessions.openOrCreate("sEarlyCompact");
      for (let i = 0; i < 4; i++) {
        record.appendMessage({ role: "user", content: `Earlier question ${i}`, timestamp: i });
        record.appendMessage(fauxAssistantMessage("h".repeat(1200)));
      }
      const model = faux.getModel();
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      const usage = { input: 2450, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2450, cost: zero };
      record.appendMessage({ ...fauxAssistantMessage("full"), provider: model.provider, model: model.id, usage });

      expect(await abortedAfter(agent, "sEarlyCompact", async () => {})).toEqual({ status: "canceled", by: "abort" });
      // The compaction did start, so the abort above is what stopped it, not a history that needed none.
      expect(debug).toHaveBeenCalledWith(expect.stringMatching(/automatic compaction threshold .*: aborted$/));
    } finally {
      debug.mockRestore();
    }
  });
});
