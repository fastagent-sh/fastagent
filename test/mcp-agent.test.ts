// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP configuration uses literal environment references.
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalAgent } from "../src/harnesses/pi-durable/serve.ts";
import { openSource } from "./open-source.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mcpGrantFile } from "../src/mcp/grants.ts";
import { inspectMcp } from "../src/mcp/host.ts";
import { mcpFixture } from "./mcp-fixture.ts";

const roots: string[] = [];
const agents: LocalAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const NODE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
async function directory(config: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-agent-"));
  roots.push(dir);
  await symlink(NODE_MODULES, join(dir, "node_modules"), "dir");
  await writeFile(join(dir, "package.json"), '{"type":"module","dependencies":{"@fastagent-sh/fastagent":"*"}}');
  await writeFile(join(dir, ".mcp.json"), JSON.stringify(config));
  await writeFile(join(dir, "SYSTEM.md"), "Use the requested tool.");
  await writeFile(
    join(dir, "fastagent.config.ts"),
    `import { createFauxCore, createModels, createProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
const core=createFauxCore({provider:"fixture",api:"fixture"});
const stream=(...args)=>{core.appendResponses([context=>{
 const last=context.messages.at(-1);
 if(last.role==="toolResult")return fauxAssistantMessage(last.content.filter(p=>p.type==="text").map(p=>p.text).join(""));
 const user=context.messages.findLast(m=>m.role==="user");const raw=typeof user.content==="string"?user.content:user.content.map(p=>p.text??"").join("");
 const cmd=JSON.parse(raw);return fauxAssistantMessage([fauxToolCall(cmd.name,cmd.args)],{stopReason:"toolUse"});
}]);return core.streamSimple(...args);};
export default {defaults:{model:"fixture/"+core.getModel().id},providers:[createProvider({id:"fixture",auth:{apiKey:{name:"fixture",resolve:async()=>({auth:{}})}},models:core.models,api:{stream,streamSimple:stream}})]};`,
  );
  return dir;
}
async function opened(dir: string, options: Parameters<typeof openSource>[1]) {
  const agent = await openSource(dir, options);
  agents.push(agent);
  return agent;
}
async function ask(agent: LocalAgent, name: string, args: Record<string, unknown> = {}, sessionId?: string) {
  const id = sessionId ?? (await agent.sessions.create()).id;
  return agent.messages.send({ sessionId: id, content: JSON.stringify({ name, args }) }, { wait: 10 });
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw e;
  }
}

it("two opens of one definition own independent stdio clients and interpolation values", async () => {
  vi.stubEnv("FASTAGENT_OFFLINE", "1");
  vi.stubEnv("UNRELATED_MCP_SECRET", "do-not-forward");
  const dir = await directory({
    mcpServers: {
      constructor: {
        command: process.execPath,
        args: [FIXTURE],
        env: { MCP_VALUE: "${VALUE}", MCP_PID_FILE: "${PID_FILE}" },
      },
    },
  });
  const pidFile = join(dir, "pids");
  expect(await inspectMcp(dir)).toMatchObject([{ name: "constructor", authorization: "not_required" }]);
  const a = await opened(dir, { stateDir: join(dir, "a"), mcp: { variables: { VALUE: "one", PID_FILE: pidFile } } });
  const b = await opened(dir, { stateDir: join(dir, "b"), mcp: { variables: { VALUE: "two", PID_FILE: pidFile } } });
  const first = JSON.parse((await ask(a, "mcp__constructor__who")).answer?.text ?? "null");
  const second = JSON.parse((await ask(b, "mcp__constructor__who")).answer?.text ?? "null");
  expect(first).toMatchObject({ value: "one", leaked: false });
  expect(second).toMatchObject({ value: "two", leaked: false });
  expect(first.pid).not.toBe(second.pid);
  expect(first.cwd).toBe(await import("node:fs/promises").then((fs) => fs.realpath(dir)));
  const again = JSON.parse((await ask(a, "mcp__constructor__who")).answer?.text ?? "null");
  expect(again.pid).toBe(first.pid);
  expect(again.calls).toBe(2);
  await a.harness.close(BACKGROUND_CONTEXT);
  await vi.waitFor(() => expect(alive(first.pid)).toBe(false));
  await a.close();
  expect((await ask(b, "mcp__constructor__who")).status).toBe("completed");
  await b.close();
  const pids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
  await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]));
});
it("an MCP ${VAR} reference is resolved from the instance's secrets, never from the process's environment", async () => {
  vi.stubEnv("FASTAGENT_OFFLINE", "1");
  vi.stubEnv("FA_MCP_REF", "from-the-process");
  const dir = await directory({
    mcpServers: { constructor: { command: process.execPath, args: [FIXTURE], env: { MCP_VALUE: "${FA_MCP_REF}" } } },
  });
  await expect(openSource(dir, { secrets: {} })).rejects.toThrow(/FA_MCP_REF/);
  const agent = await opened(dir, { secrets: { FA_MCP_REF: "from-the-secrets" } });
  expect(JSON.parse((await ask(agent, "mcp__constructor__who")).answer?.text ?? "null")).toMatchObject({
    value: "from-the-secrets",
  });
});

it("a stdio server gets the base, the declared secrets and its own env, and nothing else of the host's", async () => {
  vi.stubEnv("FASTAGENT_OFFLINE", "1");
  vi.stubEnv("UNRELATED_MCP_SECRET", "do-not-forward");
  const dir = await directory({
    mcpServers: { constructor: { command: process.execPath, args: [FIXTURE], env: { MCP_VALUE: "own" } } },
  });
  await writeFile(
    join(dir, "context.json"),
    JSON.stringify({ environment: { variables: { FA_MCP_DECLARED: { description: "for the server" } } } }),
  );
  const agent = await opened(dir, {
    stateDir: join(dir, "state"),
    secrets: { FA_MCP_DECLARED: "declared", UNRELATED_MCP_SECRET: "given-but-undeclared" },
    env: {},
  });
  const who = JSON.parse((await ask(agent, "mcp__constructor__who")).answer?.text ?? "null");
  expect(who).toMatchObject({ value: "own", declared: "declared", leaked: false });
  expect(who.ceiling).toBe(dirname(dir));
});

it("HTTP clients keep bindings isolated and closing one leaves a shared grant usable", async () => {
  vi.stubEnv("FASTAGENT_OFFLINE", "1");
  const remote = mcpFixture();
  const dir = await directory({ mcpServers: { remote: { type: "http", url: remote.url } } });
  const store = mcpGrantFile(join(dir, "grants.json"));
  await store.withGrant("shared", (tx) => tx.write(remote.grant("one", false)));
  await store.withGrant("different", (tx) => tx.write(remote.grant("two", false)));
  const opts = { mcp: { store, bindings: { remote: "shared" }, fetch: remote.fetch } };
  const a = await opened(dir, { ...opts, stateDir: join(dir, "a") });
  const b = await opened(dir, { ...opts, stateDir: join(dir, "b") });
  const c = await opened(dir, {
    stateDir: join(dir, "c"),
    mcp: { store, bindings: { remote: "different" }, fetch: remote.fetch },
  });
  expect((await ask(a, "mcp__remote__identity")).answer?.text).toBe("one");
  expect((await ask(c, "mcp__remote__identity")).answer?.text).toBe("two");
  expect((await ask(a, "mcp__remote__echo", { text: "A" })).answer?.text).toBe("A");
  const requests = remote.calls.length;
  const invalid = await ask(a, "mcp__remote__echo", { other: "not text" });
  expect(invalid.answer?.text).toMatch(/invalid|validation/i);
  expect(remote.calls).toHaveLength(requests);
  await a.close();
  expect((await ask(b, "mcp__remote__echo", { text: "B" })).answer?.text).toBe("B");
  expect(await store.read("shared")).toBeDefined();
  expect((await ask(b, "mcp__remote__bad")).answer?.text).toContain("fixture refused");
  expect((await ask(b, "mcp__remote__structured")).answer?.text).toBe('{"value":42}');
  expect((await ask(b, "mcp__remote__resource")).answer?.text).toContain("MCP tool returned unsupported content");
});
it("closing a caller during refresh joins the durable rotation and preserves another agent's grant", async () => {
  vi.stubEnv("FASTAGENT_OFFLINE", "1");
  const remote = mcpFixture();
  const dir = await directory({ mcpServers: { remote: { type: "http", url: remote.url } } });
  const store = mcpGrantFile(join(dir, "grants.json"));
  await store.withGrant("shared", (tx) => tx.write(remote.grant("one", false)));
  const mcp = { store, bindings: { remote: "shared" }, fetch: remote.fetch };
  const a = await opened(dir, { stateDir: join(dir, "a"), mcp });
  const b = await opened(dir, { stateDir: join(dir, "b"), mcp });
  await store.withGrant("shared", async (tx) => {
    const grant = tx.read();
    if (!grant) throw new Error("no grant");
    await tx.write({ ...grant, expiresAt: 0 });
  });
  remote.refreshDelay = 200;
  const sid = (await a.sessions.create()).id;
  await a.messages.send({
    sessionId: sid,
    content: JSON.stringify({ name: "mcp__remote__echo", args: { text: "waiting" } }),
  });
  await vi.waitFor(() => expect(remote.refreshes).toBe(1));
  await a.close();
  expect((await store.read("shared"))?.status).toBe("ready");
  expect((await ask(b, "mcp__remote__identity")).answer?.text).toBe("one");
  expect(remote.refreshes).toBe(1);
});

it("partial open cleans previously started children and releases the state lease", async () => {
  vi.stubEnv("FASTAGENT_OFFLINE", "1");
  const dir = await directory({
    mcpServers: {
      first: { command: process.execPath, args: [FIXTURE], env: { MCP_PID_FILE: "${PID_FILE}" } },
      second: { command: "/nonexistent/mcp-server" },
    },
  });
  const pidFile = join(dir, "pids");
  await expect(openSource(dir, { mcp: { variables: { PID_FILE: pidFile } } })).rejects.toThrow();
  const pids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
  await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]));
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  const a = await opened(dir, {});
  expect(a).toBeDefined();
});
it("cancels a stdio tool without killing its client, and does not replay an interrupted tool on reopen", async () => {
  vi.stubEnv("FASTAGENT_OFFLINE", "1");
  const dir = await directory({
    mcpServers: { local: { command: process.execPath, args: [FIXTURE], env: { MCP_EVENTS: "${EVENTS}" } } },
  });
  const events = join(dir, "events");
  const options = { mcp: { variables: { EVENTS: events } } };
  const a = await opened(dir, options);
  const sid = (await a.sessions.create()).id;
  const pending = await a.messages.send({
    sessionId: sid,
    content: JSON.stringify({ name: "mcp__local__wait", args: { ms: 10000 } }),
  });
  await vi.waitFor(async () => expect(await readFile(events, "utf8")).toContain("started"));
  await a.sessions.cancel(sid);
  await vi.waitFor(async () => expect(await readFile(events, "utf8")).toContain("aborted"));
  expect((await a.messages.get({ sessionId: sid, messageId: pending.id }, { wait: 5 })).status).toBe("canceled");
  expect((await ask(a, "mcp__local__who", {}, sid)).status).toBe("completed");
  const interrupted = await a.messages.send({
    sessionId: sid,
    content: JSON.stringify({ name: "mcp__local__wait", args: { ms: 10000 } }),
  });
  await vi.waitFor(async () => expect((await readFile(events, "utf8")).match(/started/g)).toHaveLength(2));
  await a.close();
  const b = await opened(dir, options);
  const resumed = await b.messages.get({ sessionId: sid, messageId: interrupted.id }, { wait: 5 });
  expect(resumed.answer?.text).toContain("interrupted");
  expect((await readFile(events, "utf8")).match(/started/g)).toHaveLength(2);
});
