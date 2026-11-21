/**
 * The Agent on `@fastagent-sh/harness-dsh` as a conformance subject (`agent-api-conformance.ts`):
 * mirrors `durable-subject.ts` with the exact same scripted `@earendil-works/pi-ai` model, tools,
 * failure injection, restartable storage, and external `ClockRunner`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Message,
  type TranscriptContext,
  createFauxCore,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type DshAgent,
  type DshEventStoreBackend,
  type FastAgentToolApi,
  type FastAgentToolLike,
  MemoryDshEventStore,
  openDshAgent,
} from "@fastagent-sh/harness-dsh";
import type { Change, ClockStore } from "../../packages/fastagent/src/schedule/clock.ts";
import { type ClockRunner, createClockRunner } from "../../packages/fastagent/src/schedule/runner.ts";
import type { Fire } from "../../packages/fastagent/src/schedule/state.ts";
import type { Wakeup } from "../../packages/fastagent/src/schedule/wakeups.ts";
import type { AgentApiSubject } from "./agent-api-conformance.ts";

const PROVIDER = "subject";

function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    return typeof message.content === "string"
      ? message.content
      : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  }
  return "";
}

function systemText(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join(""),
    )
    .join("\n");
}

const STREAMED = new Set(["slow", "ponder"]);

function responder() {
  let flaked = false;
  return (context: TranscriptContext) => {
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage(`answer: ${last.toolName}`);
    const text = lastUserText(context.messages);
    if (text === "flaky" && !flaked) {
      flaked = true;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 the model is overloaded" });
    }
    if (text === "instructions") return fauxAssistantMessage(`instructions: ${systemText(context.messages)}`);
    return respond(text);
  };
}

function respond(text: string) {
  switch (text) {
    case "hold":
    case "mark":
    case "stubborn":
    case "effect":
    case "finish":
    case "stream":
    case "nested":
      return fauxAssistantMessage([fauxToolCall(text, {})], { stopReason: "toolUse" });
    case "fail":
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "The model refused the request" });
    case "long":
      return fauxAssistantMessage("cut short", { stopReason: "length" });
    case "slow":
      return fauxAssistantMessage(`answer: ${"slow ".repeat(32).trim()}`);
    case "ponder":
      return fauxAssistantMessage([fauxThinking("pondering ".repeat(15).trim()), fauxText("answer: ponder")]);
    default:
      return fauxAssistantMessage(`answer: ${text}`);
  }
}

function subjectModels(signedOut: boolean) {
  const reply = responder();
  const fast = createFauxCore({ provider: PROVIDER, api: PROVIDER });
  const slow = createFauxCore({
    provider: PROVIDER,
    api: PROVIDER,
    tokensPerSecond: 110,
    tokenSize: { min: 2, max: 2 },
  });
  const stream = (...args: Parameters<typeof fast.streamSimple>) => {
    const core = STREAMED.has(lastUserText(args[1].messages)) && args[1].messages.at(-1)?.role === "user" ? slow : fast;
    core.appendResponses([reply]);
    return core.streamSimple(...args);
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: PROVIDER,
      auth: { apiKey: { name: "Subject", resolve: async () => (signedOut ? undefined : { auth: {} }) } },
      models: fast.models,
      api: { stream, streamSimple: stream },
    }),
  );
  return { models, model: { provider: PROVIDER, modelId: fast.getModel().id } };
}

function memoryClockStore(): ClockStore {
  const firesMap = new Map<string, readonly Fire[]>();
  let wakeupsState: readonly Wakeup[] = [];
  let sessionsState: Readonly<Record<string, string>> = {};
  let armedState: Readonly<Record<string, string>> = {};

  return {
    async fires<T>(name: string, change: Change<readonly Fire[], T>): Promise<T> {
      const current = firesMap.get(name) ?? [];
      const { next, result } = change(structuredClone(current));
      if (next !== undefined) firesMap.set(name, structuredClone(next));
      return result;
    },
    async wakeups<T>(change: Change<readonly Wakeup[], T>): Promise<T> {
      const { next, result } = change(structuredClone(wakeupsState));
      if (next !== undefined) wakeupsState = structuredClone(next);
      return result;
    },
    async sessions<T>(change: Change<Readonly<Record<string, string>>, T>): Promise<T> {
      const { next, result } = change(structuredClone(sessionsState));
      if (next !== undefined) sessionsState = structuredClone(next);
      return result;
    },
    async armed<T>(change: Change<Readonly<Record<string, string>>, T>): Promise<T> {
      const { next, result } = change(structuredClone(armedState));
      if (next !== undefined) armedState = structuredClone(next);
      return result;
    },
    stored: {
      fires: async (name) => structuredClone(firesMap.get(name) ?? []),
      wakeups: async () => structuredClone(wakeupsState),
      sessions: async () => structuredClone(sessionsState),
      armed: async () => structuredClone(armedState),
    },
  };
}

function failableBackend(inner: DshEventStoreBackend): { backend: DshEventStoreBackend; fail(): void } {
  let failed = false;
  const check = () => {
    if (failed) throw new Error("the disk is gone");
  };
  const wrapHandle = (handle: Awaited<ReturnType<DshEventStoreBackend["open"]>>) => ({
    ...handle,
    get closed() {
      return handle.closed;
    },
    read: async (offset?: number, length?: number) => {
      check();
      return handle.read(offset, length);
    },
    append: async (events: Parameters<typeof handle.append>[0]) => {
      check();
      return handle.append(events);
    },
    flush: async () => {
      check();
      return handle.flush();
    },
    close: () => handle.close(),
    [Symbol.asyncDispose]: () => handle[Symbol.asyncDispose](),
  });
  const backend: DshEventStoreBackend = {
    create: async (header, opts) => {
      check();
      return wrapHandle(await inner.create(header, opts));
    },
    open: async (id, access) => {
      check();
      return wrapHandle(await inner.open(id, access));
    },
    flush: async () => {
      check();
      return inner.flush();
    },
    stat: async (id) => {
      check();
      return inner.stat(id);
    },
    list: async () => {
      check();
      return inner.list();
    },
    getSessionMeta: async (id) => {
      check();
      return inner.getSessionMeta?.(id);
    },
    putSessionMeta: async (session) => {
      check();
      return inner.putSessionMeta?.(session);
    },
    listSessionMetas: async () => {
      check();
      return (await inner.listSessionMetas?.()) ?? [];
    },
    getMessage: async (sessionId, messageId) => {
      check();
      return inner.getMessage?.(sessionId, messageId);
    },
    getMessageByKey: async (sessionId, key) => {
      check();
      return inner.getMessageByKey?.(sessionId, key);
    },
    putMessage: async (message) => {
      check();
      return inner.putMessage?.(message);
    },
    listMessages: async (sessionId) => {
      check();
      return (await inner.listMessages?.(sessionId)) ?? [];
    },
    putAttachment: async (attachment) => {
      check();
      return inner.putAttachment?.(attachment);
    },
    getAttachment: async (sessionId, ref) => {
      check();
      return inner.getAttachment?.(sessionId, ref);
    },
  };
  return { backend, fail: () => (failed = true) };
}

export function dshSubject(): AgentApiSubject {
  let directory = "";
  let current: DshAgent | undefined;
  let currentClock: ClockRunner | undefined;
  let currentStore: ClockStore | undefined;
  let persistentBackend: MemoryDshEventStore | undefined;
  let fail: () => void = () => {};
  let held: (() => void)[] = [];
  let effects = 0;
  let signalled = 0;
  let signedOut = false;

  const holdTool = (name: string, description: string, before: () => void): FastAgentToolLike => ({
    name,
    description,
    parameters: { type: "object", properties: {} },
    execute: ((_args: Record<string, unknown>, _api: FastAgentToolApi, context: { abortSignal?: AbortSignal }) => {
      before();
      return new Promise((resolve, reject) => {
        const release = () => resolve({ output: [{ type: "text", text: "held" }] });
        held.push(release);
        context.abortSignal?.addEventListener(
          "abort",
          () => {
            signalled++;
            held = held.filter((other) => other !== release);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }) as FastAgentToolLike["execute"],
  });

  const allTools: FastAgentToolLike[] = [
    holdTool("hold", "Waits until the test lets it go; stops when aborted", () => {}),
    holdTool("mark", "Has an effect the test counts, then waits like hold", () => {
      effects++;
    }),
    {
      name: "stubborn",
      description: "Waits until the test lets it go, whatever its abort signal says",
      parameters: { type: "object", properties: {} },
      execute: ((_args: Record<string, unknown>, _api: FastAgentToolApi, context: { abortSignal?: AbortSignal }) =>
        new Promise((resolve) => {
          held.push(() => resolve({ output: [{ type: "text", text: "done" }] }));
          context.abortSignal?.addEventListener("abort", () => signalled++, { once: true });
        })) as FastAgentToolLike["execute"],
    },
    {
      name: "effect",
      description: "Has an effect the test counts",
      parameters: { type: "object", properties: {} },
      execute: (async () => {
        effects++;
        return { output: [{ type: "text", text: `effect ${effects}` }], details: { count: effects } };
      }) as FastAgentToolLike["execute"],
    },
    {
      name: "stream",
      description: "Writes a few status lines while it runs, keeping only the tail of them",
      parameters: { type: "object", properties: {} },
      outputLimits: { maxBytes: 24, retain: "tail" },
      execute: (async (_args: Record<string, unknown>, api: FastAgentToolApi) => {
        for (const line of ["one\n", "two\n", "three of the lines\n"]) {
          api.output?.(line);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return {};
      }) as FastAgentToolLike["execute"],
    },
    {
      name: "nested",
      description: "Calls lookup, as a codemode script does",
      parameters: { type: "object", properties: {} },
      execute: (async (
        _args: Record<string, unknown>,
        api: FastAgentToolApi,
        context: { abortSignal?: AbortSignal },
      ) => {
        await api.executeTool?.("lookup", { city: "London" }, context);
        return { output: [{ type: "text", text: "looked up" }] };
      }) as FastAgentToolLike["execute"],
    },
    {
      name: "lookup",
      description: "Looks a city up, slowly",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      execute: (async (args: { city: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { output: [{ type: "text", text: `found ${args.city}` }] };
      }) as FastAgentToolLike["execute"],
    },
    {
      name: "finish",
      description: "Ends the run without another model call",
      parameters: { type: "object", properties: {} },
      execute: (async () => ({
        output: [{ type: "text", text: "finished" }],
        control: { terminate: true },
      })) as FastAgentToolLike["execute"],
    },
  ];

  const open = async (without: readonly string[] = []): Promise<DshAgent> => {
    const { models, model } = subjectModels(signedOut);
    if (persistentBackend === undefined) persistentBackend = new MemoryDshEventStore();
    if (currentStore === undefined) currentStore = memoryClockStore();
    const wrapped = failableBackend(persistentBackend);
    fail = wrapped.fail;
    current = await openDshAgent({
      name: "subject",
      agent: { name: "Subject Program", description: "A subject." },
      starters: ["Say hello", "What can you do?"],
      workdir: directory,
      models,
      model,
      tools: allTools.filter((tool) => !without.includes(tool.name)),
      commands: () => [{ name: "greet", description: "Greets someone", expand: (args) => `hello ${args}` }],
      onSessionDelete: (sessionId) => currentClock?.onSessionDelete(sessionId),
      retry: { maxRetries: 1, baseDelayMs: 1 },
      sandbox: "off",
      storage: wrapped.backend,
    });
    currentClock = createClockRunner({
      agent: current,
      store: currentStore,
      schedules: [
        { name: "digest", cron: "0 9 * * *", prompt: "the digest" },
        { name: "long", cron: "0 9 * * *", prompt: "hold" },
      ],
    });
    return current;
  };

  return {
    async start(options) {
      await current?.close();
      directory = mkdtempSync(join(tmpdir(), "fastagent-dsh-"));
      persistentBackend = new MemoryDshEventStore();
      currentStore = memoryClockStore();
      held = [];
      effects = 0;
      signalled = 0;
      signedOut = options?.signedOut ?? false;
      return open();
    },
    async restart(options) {
      const previous = current;
      current = undefined;
      const closing = previous?.close();
      for (const release of held.splice(0)) release();
      await closing;
      return open(options?.removeTools);
    },
    release() {
      for (const release of held.splice(0)) release();
    },
    held: () => held.length,
    signalled: () => signalled,
    effects: () => effects,
    failStorage: () => fail(),
    clock: () => {
      if (currentStore === undefined) throw new Error("the subject is not open");
      return currentStore;
    },
    clockApi: () => {
      if (currentClock === undefined) throw new Error("the subject is not open");
      return currentClock.api;
    },
    async stop() {
      for (const release of held.splice(0)) release();
      await current?.close().catch(() => undefined);
      current = undefined;
      currentClock = undefined;
      currentStore = undefined;
      persistentBackend = undefined;
    },
  };
}
