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
import { Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import { piDurablePort } from "../src/harnesses/pi-durable/port.ts";
import { LIMITS } from "../src/protocol.ts";
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
let open: { harness: Harness } | undefined;

async function start(capacity?: number) {
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
      harness,
      storage,
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
});
