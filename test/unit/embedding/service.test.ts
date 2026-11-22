import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type ServingAgent, openServing } from "../../../packages/fastagent/src/harnesses/serving.ts";
import { openSource } from "../../harnesses/open-source.ts";
import { fauxAgent } from "../../doubles/cli-run.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/pi-durable/open.ts";
import { connectAgent } from "../../../packages/client/src/http/client.ts";
import { type ServeOptions, serveAgent } from "../../../packages/fastagent/src/service.ts";
import { CODEX_MODEL } from "../../doubles/codex-model.ts";
import { NOT_HOSTED } from "../../../packages/fastagent/src/serving-command.ts";

const opened: ServingAgent[] = [];
afterAll(async () => {
  for (const agent of opened) await agent.close();
});

/** The directory opened as a serve opens it, with no storage of its own, and mounted. */
async function createAgentService(dir: string, options: ServeOptions = {}) {
  const served = await openServing(await loadSourceDefinition(dir), {
    secrets: {},
    env: {},
    ownEnv: process.env,
    runsAs: NOT_HOSTED,
    storage: "memory",
  });
  opened.push(served.agent);
  return serveAgent(served, options);
}

async function agentDir(files: Record<string, string> = {}, config = `{ model: "${CODEX_MODEL}" }`): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-surface-"));
  await writeFile(join(dir, "fastagent.config.ts"), `export default ${config};\n`);
  await writeFile(join(dir, "SYSTEM.md"), "You are a test agent.\n");
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

describe("serveAgent over an opened directory", () => {
  it("answers GET /health and nothing else outside the Agent API, which it serves only with a key", async () => {
    const service = await createAgentService(await agentDir());
    try {
      const health = await service.fetch(new Request("http://h/health"));
      expect([health.status, await health.json()]).toEqual([200, { status: "ok" }]);
      expect((await service.fetch(new Request("http://h/health", { method: "POST" }))).status).toBe(405);
      expect((await service.fetch(new Request("http://h/v1/info"))).status).toBe(404);
      expect(service.api).toBe(false);
    } finally {
      await service.close();
    }
  });
});

describe("openAgent: an agent directory opened in an app", () => {
  it("serves the Agent API under /v1 only with a key", async () => {
    const dir = await agentDir();
    const unkeyed = await openSource(dir);
    const plain = await unkeyed.serve();
    expect((await plain.fetch(new Request("http://app/v1/agent"))).status).toBe(404);
    await unkeyed.close();

    const keyed = await openSource(dir);
    const service = await keyed.serve({ apiKeys: ["k"] });
    const info = await service.fetch(new Request("http://app/v1/agent", { headers: { authorization: "Bearer k" } }));
    expect(await info.json()).toMatchObject({ name: expect.any(String) });
    expect((await service.fetch(new Request("http://app/v1/agent"))).status).toBe(401);
    expect((await service.fetch(new Request("http://app/health"))).status).toBe(200);
    await keyed.close();

    const watched = await openSource(dir);
    const listening = await watched.serve({ apiKeys: ["k"] });
    const port = await listening.listen(0, "127.0.0.1");
    const { id } = await watched.sessions.create();
    const events = connectAgent(`http://127.0.0.1:${port}`, { apiKey: "k" })
      .sessions.events(id)
      [Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ type: "state" });
    // The same stream as bytes: one the server's grace cut would end in an error, not at its end.
    const raw = await fetch(`http://127.0.0.1:${port}/v1/sessions/${id}/events`, {
      headers: { authorization: "Bearer k" },
    });
    const reader = (raw.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let said = decoder.decode((await reader.read()).value);
    await watched.close();
    for (let read = await reader.read(); !read.done; read = await reader.read()) said += decoder.decode(read.value);
    expect(said).toContain("the service is closing");
    expect((await events.next()).value).toMatchObject({
      type: "stream_error",
      error: { code: "unavailable", message: "the service is closing" },
    });

    const unset = await openSource(dir);
    await expect(unset.serve({ apiKeys: [process.env.FASTAGENT_TEST_UNSET_KEY ?? ""] })).rejects.toThrow(
      "the Agent API needs at least one key, and no key may be empty",
    );
    await unset.close();
  });

  it("persists named conversations across restarts on SQLite via openAgent().invoke()", async () => {
    const dir = await fauxAgent("fa-emb-conv-");
    const first = await openSource(dir);
    const msg1 = await first.invoke({ conversation: "daily-digest", content: "run 1" }, { wait: 15 });
    expect(msg1).toMatchObject({ status: "completed", answer: { text: "seen 1" } });
    await first.close();

    const second = await openSource(dir);
    const msg2 = await second.invoke({ conversation: "daily-digest", content: "run 2" }, { wait: 15 });
    expect(msg2).toMatchObject({ status: "completed", sessionId: msg1.sessionId, answer: { text: "seen 2" } });
    await second.close();
  });
});
