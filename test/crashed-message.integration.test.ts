/**
 * A model request cut off by a crash counts as a failed attempt under the retry policy; with no retry left the message
 * it was answering ends `failed` with pi-durable's reason and detail, not `running` for ever (SPEC.md §5.4). The crash
 * is real: a child process opens the storage, starts the message and is killed, as an out-of-memory kill would.
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";

const SRC = (file: string) =>
  pathToFileURL(new URL(`../src/harnesses/pi-durable/${file}`, import.meta.url).pathname).href;
const ROOT = new URL("..", import.meta.url).pathname;

/** A process that opens the agent at `path`, sends a message a model never answers, and is killed. */
function crashedProcess(path: string): Promise<void> {
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
const s = await agent.sessions.create();
await agent.messages.send({ sessionId: s.id, content: "go", idempotencyKey: "k1" });
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
    settings: { retry: { maxRetries: 0 } },
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
  message: { status: "failed", error: { code: "internal", retryable: false, details: { reason: "interrupted" } } },
  session: { status: "idle" },
  next: { status: "completed", answer: { text: "fine now" } },
};

it("a message whose model request a crash cut off ends failed once no retry is left, and the next message runs", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "fa-crashed-")), "agent.sqlite");
  await crashedProcess(path);
  expect(await openAndRead(path)).toMatchObject(FAILED);
});
