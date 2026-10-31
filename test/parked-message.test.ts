/**
 * pi-durable's crash-loop guard parks a task a crash cut off 5 times in a row. The message it was answering must end
 * `failed`, not stay `running` for ever (SPEC.md §5.4). The crashes are real: a child process opens the storage, starts
 * the message and is killed, as an out-of-memory kill would.
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import { giveUpOnParked } from "../src/harnesses/pi-durable/parked.ts";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";

const SRC = (file: string) =>
  pathToFileURL(new URL(`../src/harnesses/pi-durable/${file}`, import.meta.url).pathname).href;
const ROOT = new URL("..", import.meta.url).pathname;

/** A process that opens the agent at `path`, sends a message a model never answers when `send`, and is killed. */
function crashedProcess(path: string, send: boolean): Promise<void> {
  const script = `
const { createModels, fauxProvider } = await import("@earendil-works/pi-ai");
const { createRegistry } = await import("@earendil-works/pi-durable");
const { openDurableAgent } = await import(${JSON.stringify(SRC("agent.ts"))});
const { openLockedStorage } = await import(${JSON.stringify(SRC("storage.ts"))});
const faux = fauxProvider({ provider: "fixture", models: [{ id: "m" }] });
faux.setResponses([() => new Promise(() => {})]);
const models = createModels();
models.setProvider(faux.provider);
const agent = await openDurableAgent({ storage: await openLockedStorage(${JSON.stringify(path)}, "posix"), models, registry: createRegistry(), name: "crash", model: { provider: "fixture", modelId: "m" } });
${send ? `const s = await agent.sessions.create(); await agent.messages.send({ sessionId: s.id, content: "go", idempotencyKey: "k1" });` : ""}
await new Promise((resolve) => setTimeout(resolve, 400));
process.kill(process.pid, "SIGKILL");`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (_code, signal) =>
      signal === "SIGKILL" ? resolve() : reject(new Error(`the child ended ${signal ?? "by itself"}, not killed`)),
    );
  });
}

/**
 * A storage whose message a model never answers, left by `crashes` more processes killed while it ran: the limit is 5
 * cut-offs, so with 4 the next open is the one that parks the task.
 */
async function crashLoop(crashes: number): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fa-parked-")), "agent.sqlite");
  await crashedProcess(path, true);
  for (let i = 0; i < crashes; i++) await crashedProcess(path, false);
  return path;
}

function fixtureModels() {
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "m" }] });
  faux.setResponses([fauxAssistantMessage("fine now")]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

/** The agent opened over `path`, its message `k1` and its session read, and a new message sent. */
async function openAndRead(path: string) {
  const agent = await openDurableAgent({
    storage: await openLockedStorage(path, "posix"),
    models: fixtureModels(),
    registry: createRegistry(),
    name: "after",
    model: { provider: "fixture", modelId: "m" },
  });
  try {
    const sessionId = (await agent.sessions.list()).data[0]?.id as string;
    return {
      message: await agent.messages.get({ sessionId, idempotencyKey: "k1" }),
      session: await agent.sessions.get(sessionId),
      next: await agent.messages.send({ sessionId, content: "again" }, { wait: 30 }),
    };
  } finally {
    await agent.close();
  }
}

const FAILED = {
  message: { status: "failed", error: { code: "internal", retryable: false, details: { reason: "restart_limit" } } },
  session: { status: "idle" },
  next: { status: "completed", answer: { text: "fine now" } },
};

it("a message whose task the crash-loop guard parked ends failed, its session is free, and the next message runs", async () => {
  expect(await openAndRead(await crashLoop(4))).toMatchObject(FAILED);
});

it("a give-up cut short, by an abort that fails or by a process that dies, is finished by the next open", async () => {
  // The first open parks the task, settles the message, and its abort fails: the session stays taken.
  const path = await crashLoop(4);
  const harness = await Harness.open(
    await openLockedStorage(path, "posix"),
    { models: fixtureModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const failingAbort = new Proxy(harness, {
    get(target, name) {
      if (name === "abortTask") {
        return async () => {
          throw new Error("the abort failed");
        };
      }
      const member = Reflect.get(target, name, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  await expect(giveUpOnParked(failingAbort, BACKGROUND_CONTEXT)).rejects.toThrow("the abort failed");
  await harness.close(BACKGROUND_CONTEXT);
  // The next open no longer hears of the task from pi-durable (its restarts are counted once), and still finds it.
  expect(await openAndRead(path)).toMatchObject(FAILED);
});
