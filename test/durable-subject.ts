/**
 * The Agent on pi-durable as a conformance subject (agent-api-conformance.ts): SQLite storage in a temporary directory,
 * a scripted model and the tools the suite's messages ask for.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Message,
  type TranscriptContext,
  Type,
  createFauxCore,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type Storage,
  type ToolExecutionResult,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type DurableAgent, openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";
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

/** What the model does, chosen by the message it answers (agent-api-conformance.ts lists the words). */
function respond(context: TranscriptContext) {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage(`answer: ${last.toolName}`);
  const text = lastUserText(context.messages);
  switch (text) {
    case "hold":
    case "mark":
    case "stubborn":
    case "effect":
    case "finish":
      return fauxAssistantMessage([fauxToolCall(text, {})], { stopReason: "toolUse" });
    case "fail":
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "The model refused the request" });
    case "long":
      return fauxAssistantMessage("cut short", { stopReason: "length" });
    case "slow":
      return fauxAssistantMessage(`answer: ${"slow ".repeat(40).trim()}`);
    default:
      return fauxAssistantMessage(`answer: ${text}`);
  }
}

/** A model provider whose `slow` answers stream a few tokens at a time, so an answer is seen being written. */
function subjectModels(signedOut: boolean) {
  const fast = createFauxCore({ provider: PROVIDER, api: PROVIDER });
  const slow = createFauxCore({
    provider: PROVIDER,
    api: PROVIDER,
    tokensPerSecond: 60,
    tokenSize: { min: 2, max: 2 },
  });
  const stream = (...args: Parameters<typeof fast.streamSimple>) => {
    const core = lastUserText(args[1].messages) === "slow" && args[1].messages.at(-1)?.role === "user" ? slow : fast;
    core.appendResponses([respond]);
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

/** A storage that fails every call once `fail()` is called, as a lost disk would. */
function failable(storage: Storage): { storage: Storage; fail(): void } {
  let failed = false;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (failed && property !== "close") throw new Error("the disk is gone");
        return value.apply(target, args);
      };
    },
  });
  return { storage: proxy, fail: () => (failed = true) };
}

export function durableSubject(): AgentApiSubject {
  let directory = "";
  let current: DurableAgent | undefined;
  let fail: () => void = () => {};
  let held: (() => void)[] = [];
  let effects = 0;
  let signalled = 0;
  let inFlight: number | undefined;
  let signedOut = false;

  const holdTool = (name: string, description: string, before: () => void) =>
    defineTool({
      name,
      description,
      parameters: Type.Object({}),
      execute: (_args, _api, context) => {
        before();
        return new Promise<ToolExecutionResult>((resolve, reject) => {
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
      },
    });

  const tools = defineExtension({
    name: "subject",
    tools: [
      holdTool("hold", "Waits until the test lets it go; stops when aborted", () => {}),
      holdTool("mark", "Has an effect the test counts, then waits like hold", () => {
        effects++;
      }),
      defineTool({
        name: "stubborn",
        description: "Waits until the test lets it go, whatever its abort signal says",
        parameters: Type.Object({}),
        execute: (_args, _api, context) =>
          new Promise<ToolExecutionResult>((resolve) => {
            held.push(() => resolve({ output: [{ type: "text", text: "done" }] }));
            context.abortSignal?.addEventListener("abort", () => signalled++, { once: true });
          }),
      }),
      defineTool({
        name: "effect",
        description: "Has an effect the test counts",
        parameters: Type.Object({}),
        execute: async () => {
          effects++;
          return { output: [{ type: "text", text: `effect ${effects}` }] };
        },
      }),
      defineTool({
        name: "finish",
        description: "Ends the run without another model call",
        parameters: Type.Object({}),
        execute: async () => ({ output: [{ type: "text", text: "finished" }], control: { terminate: true } }),
      }),
    ],
  });

  const open = async (): Promise<DurableAgent> => {
    const { models, model } = subjectModels(signedOut);
    const registry = createRegistry();
    registry.install(tools);
    const storage = failable(await openNodeSqliteStorage(join(directory, "agent.sqlite")));
    fail = storage.fail;
    current = await openDurableAgent({
      storage: storage.storage,
      models,
      registry,
      name: "subject",
      model,
      commands: [{ name: "greet", description: "Greets someone", expand: (args) => `hello ${args}` }],
      settings: { retry: { maxRetries: 0 } },
      ...(inFlight === undefined ? {} : { inFlightPerProcess: inFlight }),
    });
    return current;
  };

  return {
    async start(options) {
      await current?.close();
      directory = mkdtempSync(join(tmpdir(), "fastagent-durable-"));
      held = [];
      effects = 0;
      signalled = 0;
      inFlight = options?.inFlightPerProcess;
      signedOut = options?.signedOut ?? false;
      return open();
    },
    async restart() {
      const previous = current;
      current = undefined;
      // Closing interrupts running work without settling it, as a process that stops does.
      const closing = previous?.close();
      for (const release of held.splice(0)) release();
      await closing;
      return open();
    },
    release() {
      for (const release of held.splice(0)) release();
    },
    held: () => held.length,
    signalled: () => signalled,
    effects: () => effects,
    failStorage: () => fail(),
    async stop() {
      for (const release of held.splice(0)) release();
      await current?.close().catch(() => undefined);
      current = undefined;
    },
  };
}
