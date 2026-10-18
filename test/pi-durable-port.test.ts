/**
 * The SPEC v1 suite against pi-durable through its own port, on SQLite storage on disk. What a message's work does is
 * chosen by its text, as the suite asks: the faux model answers the newest user message, `hold` and `effect` call
 * tools of those names first, and `fail` is an error the model returns. A restart closes the harness mid-work and opens
 * the same file again, which is where its runs continue.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type FauxResponseStep,
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Harness, type Storage, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, vi } from "vitest";
import { piDurablePort } from "../src/harnesses/pi-durable/port.ts";
import { type InvokeEvent, LIMITS } from "../src/protocol.ts";
import { collect } from "../src/protocol-collect.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { describeProtocolConformance } from "./protocol-conformance.ts";

const context = BACKGROUND_CONTEXT;

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
const answer: FauxResponseStep = (ctx): AssistantMessage => {
  const messages = ctx.messages as Message[];
  const last = messages.at(-1);
  const user = [...messages].reverse().find((m) => m.role === "user");
  const text = textOf(user);
  if (last?.role === "user" && (text === "hold" || text === "effect")) {
    return fauxAssistantMessage(fauxToolCall(text, {}, { id: `call-${++calls}` }), { stopReason: "toolUse" });
  }
  if (text === "fail") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" });
  return fauxAssistantMessage(`answer: ${text}`);
};

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

let file = "";
let held = gate();
let effects = 0;
/** How many `hold` calls have started. */
let holds = 0;
let open: { harness: Harness } | undefined;

/** A property of `target` read through a proxy: its methods keep `target` as `this` (private fields need it). */
const bound = (target: object, key: string | symbol): unknown => {
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
};

/** What a test changes in the port's surroundings: the storage the port reads, the harness it drives. */
type Wrap = { storage?: (storage: Storage) => Storage; harness?: (harness: Harness) => Harness };

async function start(capacity?: number, wrap: Wrap = {}) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 2000 }, () => answer));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const parameters = Type.Object({});
  const tools = [
    defineTool({
      name: "hold",
      description: "waits until released",
      parameters,
      execute: async (_args, _api, ctx) => {
        holds++;
        await Promise.race([
          held.opened,
          new Promise<void>((resolve) => ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true })),
        ]);
        return { output: [{ type: "text" as const, text: "held" }] };
      },
    }),
    defineTool({
      name: "effect",
      description: "has an effect",
      parameters,
      execute: async () => {
        effects++;
        return { output: [{ type: "text" as const, text: "done" }] };
      },
    }),
  ];
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test", tools }));
  const storage = await openNodeSqliteStorage(file);
  const harness = await Harness.open(storage, { models, registry }, context);
  harness.resume();
  open = { harness };
  return servingAgent(
    await piDurablePort({
      harness: wrap.harness?.(harness) ?? harness,
      storage: wrap.storage?.(storage) ?? storage,
      context,
      model: { provider: model.provider, modelId: model.id },
      models: async () => [{ spec: `${model.provider}/${model.id}`, thinkingLevels: [] }],
      inFlightPerProcess: capacity ?? LIMITS.inFlightPerProcess,
    }),
  );
}

describeProtocolConformance("pi-durable", {
  start: async ({ capacity } = {}) => {
    await open?.harness.close(context);
    file = join(await mkdtemp(join(tmpdir(), "pi-durable-")), "state.sqlite");
    held = gate();
    effects = 0;
    return start(capacity);
  },
  restart: async () => {
    await open?.harness.close(context);
    held = gate();
    return start();
  },
  release: () => held.open(),
  effects: () => effects,
});

describe("pi-durable port", () => {
  it("a message whose work failed before its end was written gets it when the port opens", async () => {
    file = join(await mkdtemp(join(tmpdir(), "pi-durable-")), "state.sqlite");
    // A first process: one message taken and failed, and nothing else, as if it stopped right after.
    const first = await start();
    const events = [];
    for await (const event of first.invoke({ sessionId: "s", prompt: { text: "first" } })) events.push(event);
    await open?.harness.close(context);
    const storage = await openNodeSqliteStorage(file);
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
    const models = createModels();
    models.setProvider(faux.provider);
    const bare = await Harness.open(storage, { models, registry: createRegistry() }, context);
    const [only] = (await storage.scanConversations({ order: "descending" }, 1, undefined, context)).items;
    const target = only && (await bare.conversation(only.id, context));
    if (!target) throw new Error("the first process left no conversation");
    await target.configure({ model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }, context);
    const submission = await target.submit(
      {
        type: "input",
        content: "fail",
        requestId: "m:failed",
        entry: { kind: "fastagent.user", data: { messageId: "m:failed", source: { kind: "api" } } },
      },
      context,
    );
    expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
    await bare.close(context);

    const agent = await start();
    const followed = [];
    for await (const event of agent.sessions.get("s").messages.follow("m:failed")) followed.push(event);
    const done = followed.at(-1);
    expect(done).toMatchObject({ type: "done", message: { outcome: { status: "failed" } } });
    const lastEntryId = done?.type === "done" ? done.message.lastEntryId : undefined;
    const entries = followed.flatMap((e) => (e.type === "entry" ? [e.entry] : []));
    expect(entries.map((e) => e.kind)).toEqual(["user_message", "assistant_message"]);
    expect(lastEntryId).toBe(entries.at(-1)?.id);
  });

  it("a failure following a message's work is logged and made good from the log", { timeout: 30_000 }, async () => {
    file = join(await mkdtemp(join(tmpdir(), "pi-durable-")), "state.sqlite");
    let failing = true;
    const agent = await start(undefined, {
      storage: (storage) =>
        new Proxy(storage, {
          get: (target, key) =>
            key === "submission"
              ? async (...args: Parameters<Storage["submission"]>) => {
                  const record = await target.submission(...args);
                  if (record?.status === "unanswered" && failing) {
                    failing = false;
                    throw new Error("disk unavailable");
                  }
                  return record;
                }
              : bound(target, key),
        }),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // `fail` ends unanswered: the read that would write where its work ended fails, and the port makes it good.
      const events = [];
      for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "fail" } })) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "done", message: { outcome: { status: "failed" } } });
      expect(events.some((e) => e.type === "serving_error")).toBe(false);
      expect(failing).toBe(false);
      expect(error.mock.calls.flat().join(" ")).toContain("disk unavailable");
    } finally {
      error.mockRestore();
    }
  });

  it("a message whose work stopped is taken until where that work ended is written, then done", {
    timeout: 30_000,
  }, async () => {
    file = join(await mkdtemp(join(tmpdir(), "pi-durable-")), "state.sqlite");
    let release!: () => void;
    const written = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    // The port's read of a run's unanswered inputs, the one before it writes where their work ended, waits.
    const agent = await start(undefined, {
      storage: (storage) =>
        new Proxy(storage, {
          get: (target, key) =>
            key === "submission"
              ? async (...args: Parameters<Storage["submission"]>) => {
                  const record = await target.submission(...args);
                  if (record?.status === "unanswered" && !held) {
                    held = true;
                    await written;
                  }
                  return record;
                }
              : bound(target, key),
        }),
    });
    const session = agent.sessions.get("s");
    const stream = collect(agent.invoke({ sessionId: "s", prompt: { text: "fail" } }));
    const messageId = await vi.waitFor(async () => {
      const page = await session.read();
      const failed = page.ok ? page.entries.find((e) => e.kind === "assistant_message") : undefined;
      if (!failed) throw new Error("not failed yet");
      return (page.ok ? page.entries[0]?.data : {}) as { messageId: string };
      // pi-durable retries a model error with backoff before it gives up.
    }, 20_000);
    expect(await session.messages.get({ messageId: messageId.messageId })).toMatchObject({ status: "taken" });
    release();
    await expect(stream).rejects.toThrow("boom");
    const done = await session.messages.get({ messageId: messageId.messageId });
    const page = await session.read();
    expect(done).toMatchObject({ status: "done", lastEntryId: page.ok ? page.entries.at(-1)?.id : "" });
  });

  it("concurrent creates of one session id make one session; the rest are conflicts", async () => {
    file = join(await mkdtemp(join(tmpdir(), "pi-durable-")), "state.sqlite");
    const agent = await start();
    const results = await Promise.all([1, 2, 3].map(() => agent.sessions.create({ sessionId: "s" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.error.code))).toEqual(["conflict", "conflict"]);
    const [created, invoked] = await Promise.all([
      agent.sessions.create({ sessionId: "t" }),
      collect(agent.invoke({ sessionId: "t", prompt: { text: "hi" } })),
    ]);
    expect(created.ok || created.error.code === "conflict").toBe(true);
    expect(invoked.text).toBe("answer: hi");
    expect(await agent.sessions.get("t").messages.get({ messageId: invoked.messageId })).toMatchObject({
      status: "done",
    });
  });

  it("where failed work ended is written at once, though a new message starts work first", {
    timeout: 30_000,
  }, async () => {
    file = join(await mkdtemp(join(tmpdir(), "pi-durable-")), "state.sqlite");
    held = gate();
    let release!: () => void;
    const reading = new Promise<void>((resolve) => (release = resolve));
    let gated = false;
    // The read before the end is written waits, so the next message starts work in between.
    const agent = await start(undefined, {
      storage: (storage) =>
        new Proxy(storage, {
          get: (target, key) =>
            key === "submission"
              ? async (...args: Parameters<Storage["submission"]>) => {
                  const record = await target.submission(...args);
                  if (record?.status === "unanswered" && !gated) {
                    gated = true;
                    await reading;
                  }
                  return record;
                }
              : bound(target, key),
        }),
    });
    const session = agent.sessions.get("s");
    const failed = collect(agent.invoke({ sessionId: "s", prompt: { text: "fail" } }));
    void failed.catch(() => {});
    await vi.waitFor(() => expect(gated).toBe(true), { timeout: 20_000 });
    const next = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    await vi.waitFor(async () => expect((await session.messages.get({ messageId: next }))?.status).toBe("taken"));
    const state = await session.read({ limit: 0 });
    // Both planes say the same: the failed message is taken until where its work ended is written.
    expect(state.ok && state.state.taken.length).toBe(2);
    release();
    await expect(failed).rejects.toThrow("boom");
    expect((await session.messages.get({ messageId: next }))?.status).toBe("taken");
    held.open();
  });

  it("canceling a message stops its work, and every message that work took ends canceled by cancel", async () => {
    file = join(await mkdtemp(join(tmpdir(), "pi-durable-")), "state.sqlite");
    held = gate();
    const agent = await start();
    const session = agent.sessions.get("s");
    const first = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    const before = holds;
    await vi.waitFor(() => expect(holds).toBe(before + 1), { timeout: 5000 });
    const steer = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" }, whenBusy: "steer" })))
      .message.messageId;
    // The first tool round ends, the steer is taken into the same work, and its own tool call holds again.
    const firstRound = held;
    held = gate();
    firstRound.open();
    await vi.waitFor(async () => expect((await session.messages.get({ messageId: steer }))?.status).toBe("taken"), {
      timeout: 5000,
    });
    expect(await session.messages.cancel(first)).toEqual({ ok: true });
    const canceled = { status: "done", outcome: { status: "canceled", by: "cancel" } };
    await vi.waitFor(async () => expect(await session.messages.get({ messageId: first })).toMatchObject(canceled));
    await vi.waitFor(async () => expect(await session.messages.get({ messageId: steer })).toMatchObject(canceled));
  });

  it("a thinking level the session's model does not take is refused, and nothing is written", async () => {
    file = join(await mkdtemp(join(tmpdir(), "pi-durable-")), "state.sqlite");
    const agent = await start();
    await agent.sessions.create({ sessionId: "s" });
    const refused = await agent.sessions.get("s").update({ name: "named", thinkingLevel: "banana" });
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const read = await agent.sessions.get("s").read({ limit: 0 });
    expect(read.ok && read.state.name).toBeUndefined();
  });
});

async function receiptOf(events: AsyncIterable<InvokeEvent>) {
  for await (const event of events) if (event.type === "accepted") return event;
  throw new Error("not accepted");
}
