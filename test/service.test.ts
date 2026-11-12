import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { openSource } from "./open-source.ts";
import { loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { connectAgent } from "../src/http/client.ts";
import { type ServeOptions, serveAgent } from "../src/service.ts";
import { CODEX_MODEL } from "./codex-model.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";

const opened: DurableAgent[] = [];
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

async function agentDir(
  files: Record<string, string> = {},
  config = `{ defaults: { model: "${CODEX_MODEL}" } }`,
): Promise<string> {
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
  it("mounts channel routes on a handler, with health beside them", async () => {
    const dir = await agentDir({
      "src/channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("from-channel") });`,
    });
    const service = await createAgentService(dir);
    try {
      expect(await (await service.fetch(new Request("http://h/hook", { method: "POST" }))).text()).toBe("from-channel");
      expect((await service.fetch(new Request("http://h/health"))).status).toBe(200);
      expect(service.channels.routes).toEqual(["hook"]);
      // Only routes that verify their caller are served: the agent has no network binding of its own.
      expect(Object.keys(service.routes).sort()).toEqual(["GET /health", "POST /hook"]);
    } finally {
      await service.close();
    }
  });

  it("a schedule in src/schedules/ reaches the clock", async () => {
    const dir = await agentDir({
      "src/schedules/daily.ts": `import { defineSchedule } from "@fastagent-sh/fastagent";
export default defineSchedule({ cron: "0 9 * * *", prompt: "summarise the day" });\n`,
    });
    const service = await createAgentService(dir);
    try {
      expect(service.schedules).toEqual([{ name: "daily", cron: "0 9 * * *", prompt: "summarise the day" }]);
    } finally {
      await service.close();
    }
  });
});

describe("a serve points its webhook channels at itself", () => {
  /** A `telegram` route channel, as the first-party one is reached, and the secrets that point it. */
  async function telegramService(config: Record<string, unknown> = {}, secrets: Record<string, string> = {}) {
    const dir = await agentDir({
      "src/channels/telegram.mjs": `export default () => ({ "POST /telegram": () => new Response("ok") });`,
    });
    const served = await openServing(await loadSourceDefinition(dir), {
      secrets,
      env: {},
      ownEnv: process.env,
      runsAs: NOT_HOSTED,
      storage: "memory",
      config: { values: config, label: "test" },
    });
    opened.push(served.agent);
    return serveAgent(served);
  }
  const health = async (service: { fetch(r: Request): Promise<Response> }) =>
    (await service.fetch(new Request("http://h/health"))).json();

  it("reports every webhook channel pending in /health until a registration ends, as JSON", async () => {
    const service = await telegramService();
    try {
      expect(await health(service)).toEqual({ status: "ok", webhooks: [{ channel: "telegram", outcome: "pending" }] });
      expect(service.webhooks).toEqual([{ channel: "telegram", outcome: "pending" }]);
    } finally {
      await service.close();
    }
  });
});

describe("openAgent: an agent directory opened in an app", () => {
  it("serves the Agent API under /v1 beside its routes only with a key, and keeps /v1 from a channel", async () => {
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

    const claiming = await openSource(
      await agentDir({
        "src/channels/claims.mjs": `export default () => ({ "POST /v1/hook": () => new Response("ok") });`,
      }),
    );
    await expect(claiming.serve()).rejects.toThrow('route "POST /v1/hook" is under /v1, which the Agent API serves');
    await claiming.close();
  });
});
