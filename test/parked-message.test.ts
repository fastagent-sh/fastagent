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
import { createRegistry } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";
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

it("a message whose task the crash-loop guard parked ends failed, its session is free, and the next message runs", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "fa-parked-")), "agent.sqlite");
  await crashedProcess(path, true);
  for (let i = 0; i < 6; i++) await crashedProcess(path, false);

  const faux = fauxProvider({ provider: "fixture", models: [{ id: "m" }] });
  faux.setResponses([fauxAssistantMessage("fine now")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = await openDurableAgent({
    storage: await openLockedStorage(path, "posix"),
    models,
    registry: createRegistry(),
    name: "after",
    model: { provider: "fixture", modelId: "m" },
  });
  try {
    const { data } = await agent.sessions.list();
    const sessionId = data[0]?.id as string;
    expect(await agent.messages.get({ sessionId, idempotencyKey: "k1" })).toMatchObject({
      status: "failed",
      error: { code: "internal", retryable: false, details: { reason: "restart_limit" } },
    });
    expect(await agent.sessions.get(sessionId)).toMatchObject({ status: "idle" });
    expect(await agent.messages.send({ sessionId, content: "again" }, { wait: 30 })).toMatchObject({
      status: "completed",
      answer: { text: "fine now" },
    });
  } finally {
    await agent.close();
  }
});
