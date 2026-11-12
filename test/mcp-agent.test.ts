// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP configuration uses literal environment references.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mcpGrantFile } from "../src/mcp/grants.ts";
import { inspectMcp } from "../src/mcp/host.ts";
import { mcpFixture } from "./mcp-fixture.ts";
import { roots, agents, FIXTURE, directory, opened, ask } from "./mcp-agent-fixtures.ts";

afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("inspectMcp reads the fastagent.json in a root as openAgent does, unless a config is given", async () => {
  const dir = await directory({ mcpServers: { constructor: { command: process.execPath, args: [FIXTURE] } } });
  const root = await mkdtemp(join(tmpdir(), "mcp-root-"));
  roots.push(root);
  expect(await inspectMcp(dir, { root })).toMatchObject([{ name: "constructor" }]);
  await writeFile(
    join(root, "fastagent.json"),
    JSON.stringify({ mcpServers: { extra: { command: process.execPath, args: [FIXTURE] } } }),
  );
  expect(await inspectMcp(dir, { root })).toMatchObject([{ name: "constructor" }, { name: "extra" }]);
  expect(await inspectMcp(dir, { root, config: {} })).toMatchObject([{ name: "constructor" }]);
  await expect(inspectMcp(dir, { root: "relative" })).rejects.toThrow("root must be an absolute path");
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
it("grants an instance is given no store for are the state directory's, and not the secrets directory's", async () => {
  vi.stubEnv("FASTAGENT_OFFLINE", "1");
  const remote = mcpFixture();
  const dir = await directory({ mcpServers: { remote: { type: "http", url: remote.url } } });
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  await mcpGrantFile(join(stateDir, "mcp-auth.json")).withGrant("shared", (tx) =>
    tx.write(remote.grant("state", false)),
  );
  await writeFile(join(stateDir, "mcp-bindings.json"), JSON.stringify({ remote: "shared" }));
  const decoy = join(dir, "decoy-secrets");
  await mkdir(decoy, { recursive: true });
  await mcpGrantFile(join(decoy, "mcp-auth.json")).withGrant("shared", (tx) => tx.write(remote.grant("decoy", false)));
  vi.stubEnv("FASTAGENT_SECRETS_DIR", decoy);
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await mcpGrantFile(join(dir, ".secrets", "mcp-auth.json")).withGrant("shared", (tx) =>
    tx.write(remote.grant("project", false)),
  );
  const agent = await opened(dir, { stateDir, mcp: { fetch: remote.fetch } });
  expect((await ask(agent, "mcp__remote__identity")).answer?.text).toBe("state");
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
