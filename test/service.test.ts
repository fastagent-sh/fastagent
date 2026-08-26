/**
 * The product's assembly, end to end: a directory becomes a mounted handler.
 *
 * These are the properties an embedder gets for free by calling one function instead of composing
 * the parts. Each was, at some point, composed wrong — inside this repo's own CLI.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { createAgentService } from "../src/service.ts";

async function agentDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-surface-"));
  await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
  await writeFile(join(dir, "persona.md"), "You are a test agent.\n");
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

describe("createAgentService", () => {
  it("mounts channel routes on a handler, with health beside them", async () => {
    const dir = await agentDir({
      "channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("from-channel") });`,
    });
    const service = await createAgentService(dir);
    try {
      expect(await (await service.handler(new Request("http://h/hook", { method: "POST" }))).text()).toBe(
        "from-channel",
      );
      expect((await service.handler(new Request("http://h/health"))).status).toBe(200);
      expect(service.channels.routes).toEqual(["hook"]);
      // A declared channel replaces the built-in /invoke — the fallback exists only when there is none.
      expect((await service.handler(new Request("http://h/invoke", { method: "POST" }))).status).toBe(404);
      expect(service.channels.builtinInvoke).toBe(false);
    } finally {
      await service.close();
    }
  });

  it("falls back to POST /invoke when the directory declares no channel", async () => {
    const dir = await agentDir();
    const service = await createAgentService(dir);
    try {
      // 400 rather than 404: the route is mounted and rejecting an empty body.
      expect((await service.handler(new Request("http://h/invoke", { method: "POST" }))).status).toBe(400);
    } finally {
      await service.close();
    }
  });

  it("mounts the control plane when the config asks for it, reachable on the same handler", async () => {
    // THE property composing by hand gets wrong: routes and mounts must both reach the router. This
    // repo shipped a version where they did not — /control/* 404'd while control.json advertised it.
    const dir = await mkdtemp(join(tmpdir(), "fa-surface-ctl-"));
    await writeFile(
      join(dir, "fastagent.config.mjs"),
      `export default { model: "openai-codex/gpt-5.5", sessionControl: true };\n`,
    );
    await writeFile(join(dir, "persona.md"), "You are a test agent.\n");
    const service = await createAgentService(dir);
    try {
      // 401, not 404: the plane is mounted and asking for the token it minted.
      expect((await service.handler(new Request("http://h/control/capabilities"))).status).toBe(401);
      expect(service.mounts.map((m) => m.prefix)).toEqual(["/control"]);
    } finally {
      await service.close();
    }
  });

  it("hands the embedder the plane's token, and cleans the discovery file up on close", async () => {
    // An embedded surface has no port of its own to advertise, so `control` is how a client gets
    // access at all. `announce` stays available for a host that does have one — and its file must
    // not outlive the surface, or `attach` reads a stale token and gets a misleading 401.
    const dir = await mkdtemp(join(tmpdir(), "fa-surface-token-"));
    await writeFile(
      join(dir, "fastagent.config.mjs"),
      `export default { model: "openai-codex/gpt-5.5", sessionControl: true };\n`,
    );
    await writeFile(join(dir, "persona.md"), "You are a test agent.\n");
    const service = await createAgentService(dir);
    expect(service.control?.prefix).toBe("/control");
    expect(service.control?.token).toMatch(/[0-9a-f-]{36}/);
    // The token actually opens the plane it came from.
    const res = await service.handler(
      new Request("http://h/control/capabilities", { headers: { authorization: `Bearer ${service.control?.token}` } }),
    );
    expect(res.status).toBe(200);

    service.announce(8787);
    const discovery = join(service.agentDir, ".state", "control.json");
    expect(JSON.parse(await readFile(discovery, "utf8"))).toMatchObject({ token: service.control?.token });
    await service.close();
    await expect(readFile(discovery, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("a connection that dies after coming up makes health say so again", async () => {
    // Readiness is two-way: the surface would otherwise keep telling a load balancer it serves a
    // channel it no longer has.
    const dir = await agentDir({
      "channels/sock.mjs": `let end; export default {
        name: "sock",
        connect: (ctx, signal) => ({
          ready: Promise.resolve(),
          closed: new Promise((resolve) => { globalThis.__faDropSock = resolve; }),
        }),
      };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {} });
    try {
      await service.ready;
      expect((await service.handler(new Request("http://h/health"))).status).toBe(200);
      (globalThis as unknown as { __faDropSock?: () => void }).__faDropSock?.(); // the channel drops
      await new Promise((r) => setTimeout(r, 20));
      expect((await service.handler(new Request("http://h/health"))).status).toBe(503);
    } finally {
      await service.close();
    }
  });

  it("a drop during startup fails startup, whatever the other connections do", async () => {
    // Interleaving: one channel dies while another is still dialling. Startup must FAIL — resolving
    // `ready` while health is permanently 503 would answer the same question two ways.
    (globalThis as Record<string, unknown>).__faSlowReady = undefined;
    const dir = await agentDir({
      "channels/dies.mjs": `export default { name: "dies", connect: () => ({
        ready: Promise.resolve(), closed: Promise.resolve() }) };`,
      "channels/slow.mjs": `export default { name: "slow", connect: (ctx, signal) => ({
        ready: new Promise((r) => { globalThis.__faSlowReady = r; }),
        closed: new Promise((r) => signal.addEventListener("abort", () => r(), { once: true })),
      }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {} });
    try {
      await new Promise((r) => setTimeout(r, 20)); // let "dies" report closed
      (globalThis as unknown as { __faSlowReady?: () => void }).__faSlowReady?.();
      await expect(service.ready).rejects.toThrow(/closed before startup completed/);
      expect((await service.handler(new Request("http://h/health"))).status).toBe(503);
    } finally {
      await service.close();
    }
  });

  it("does not mount a control plane the config did not ask for", async () => {
    const service = await createAgentService(await agentDir());
    try {
      expect(service.mounts).toEqual([]);
      expect((await service.handler(new Request("http://h/control/capabilities"))).status).toBe(404);
    } finally {
      await service.close();
    }
  });

  it("close() waits for the connection to actually close, not just for the signal", async () => {
    // The promise says "stopped", so a caller tearing down a surface needs that true on return. The
    // channel takes 30ms after the abort — an implementation that only signals resolves too early,
    // and the flag is still unset. Observed through a global because the channel module is loaded by
    // the surface, not by this test.
    (globalThis as Record<string, unknown>).__faSockClosed = false;
    const dir = await agentDir({
      "channels/sock.mjs": `export default {
        name: "sock",
        connect: (ctx, signal) => ({
          ready: Promise.resolve(),
          closed: new Promise((resolve) => signal.addEventListener("abort", () => {
            setTimeout(() => { globalThis.__faSockClosed = true; resolve(); }, 30);
          }, { once: true })),
        }),
      };`,
    });
    const service = await createAgentService(dir);
    expect(service.channels.longConnections).toEqual(["sock"]);
    await service.close();
    expect((globalThis as Record<string, unknown>).__faSockClosed).toBe(true);
    await expect(service.close()).resolves.toBeUndefined(); // idempotent
  });

  it("close() detaches from the caller's signal", async () => {
    // A host that opens and closes surfaces while holding one long-lived signal would otherwise
    // accumulate listeners, each pinning a whole closed surface through its closure.
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;
    const service = await createAgentService(await agentDir(), { signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort").length).toBe(before + 1);
    await service.close();
    expect(getEventListeners(controller.signal, "abort").length).toBe(before);
  });

  it("an already-aborted signal closes the surface before open() returns", async () => {
    (globalThis as Record<string, unknown>).__faAbortedClosed = false;
    const dir = await agentDir({
      "channels/sock.mjs": `export default {
        name: "sock",
        connect: (ctx, signal) => ({
          ready: Promise.resolve(),
          closed: new Promise((resolve) => signal.addEventListener("abort", () => {
            globalThis.__faAbortedClosed = true; resolve();
          }, { once: true })),
        }),
      };`,
    });
    // A listener added to an already-aborted signal never fires, so the surface would stay open with
    // its connections and scheduler running behind a caller who believes it is shut.
    const service = await createAgentService(dir, { signal: AbortSignal.abort() });
    expect((globalThis as Record<string, unknown>).__faAbortedClosed).toBe(true);
    await service.close();
  });

  it("closes on its own signal, and close() is idempotent", async () => {
    const controller = new AbortController();
    const service = await createAgentService(await agentDir(), { signal: controller.signal });
    controller.abort();
    await expect(service.close()).resolves.toBeUndefined();
    await expect(service.close()).resolves.toBeUndefined();
  });

  it("a long connection that cannot come up rejects `ready` and tears the surface down", async () => {
    // Not a degraded surface: a declared channel that is dead means this deployment is not serving
    // what it was configured to serve. `ready` carries that to the caller — the CLI fails startup,
    // an embedder gets a rejection it can handle — and nothing is left running behind it.
    (globalThis as Record<string, unknown>).__faFailClosed = false;
    const dir = await agentDir({
      "channels/sock.mjs": `export default {
        name: "sock",
        connect: (ctx, signal) => ({
          ready: Promise.reject(new Error("dial refused")),
          closed: new Promise((resolve) => signal.addEventListener("abort", () => {
            globalThis.__faFailClosed = true; resolve();
          }, { once: true })),
        }),
      };`,
    });
    const service = await createAgentService(dir);
    await expect(service.ready).rejects.toThrow(/dial refused/);
    expect((globalThis as Record<string, unknown>).__faFailClosed).toBe(true); // torn down, not left up
    // Health never flipped to 200: the surface must not advertise itself as serving.
    expect((await service.handler(new Request("http://h/health"))).status).toBe(503);
  });

  it("a connection that dies while dialling fails startup instead of hanging it", async () => {
    // The contract puts a terminal failure on `closed`, and a channel that dies before connecting
    // may never settle `ready`. Waiting on `ready` alone hangs open() forever with no diagnosis.
    const dir = await agentDir({
      "channels/stuck.mjs": `export default { name: "stuck", connect: () => ({
        ready: new Promise(() => {}),
        closed: Promise.reject(new Error("dial refused")),
      }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {} });
    await expect(service.ready).rejects.toThrow(/stuck failed before it was ready|dial refused/);
  });

  it("a failed start reports the start failure, not the cleanup's", async () => {
    // Both fail here: the connection cannot come up AND cannot stop. The caller needs the first —
    // the second is the aftermath, and replacing one with the other hides the actual cause.
    const dir = await agentDir({
      "channels/doomed.mjs": `export default { name: "doomed", connect: () => ({
        ready: Promise.reject(new Error("dial refused")),
        closed: Promise.reject(new Error("and could not stop either")),
      }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {} });
    await expect(service.ready).rejects.toThrow(/dial refused/);
  });

  it("a channel that ignores its abort signal cannot hang teardown", async () => {
    // `closed` never settles here. Without a deadline `close()` waits forever — and during a failed
    // START, the original error would never reach the caller at all.
    const dir = await agentDir({
      "channels/deaf.mjs": `export default { name: "deaf", connect: () => ({
        ready: Promise.resolve(), closed: new Promise(() => {}) }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {}, closeTimeoutMs: 200 });
    await service.ready;
    await expect(service.close()).rejects.toThrow(/did not stop within 200ms: deaf/);
  });

  it("names only the connection that is stuck, not the ones that stopped", async () => {
    // A shutdown message that blames every channel because one hung sends the reader to the wrong
    // file. The deadline reports what did not settle, individually.
    const dir = await agentDir({
      "channels/quick.mjs": `export default { name: "quick", connect: (ctx, signal) => ({
        ready: Promise.resolve(),
        closed: new Promise((r) => signal.addEventListener("abort", () => r(), { once: true })),
      }) };`,
      "channels/deaf.mjs": `export default { name: "deaf", connect: () => ({
        ready: Promise.resolve(), closed: new Promise(() => {}) }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {}, closeTimeoutMs: 200 });
    await service.ready;
    const error = await service.close().catch((e: Error) => e);
    expect(String(error)).toMatch(/deaf/);
    expect(String(error)).not.toMatch(/quick/);
  });

  it("close() reports a connection that failed to stop", async () => {
    // `closed` carries a terminal failure by contract. Swallowing it would let `close()` claim the
    // surface is stopped over a channel that did not stop, and the caller could never tell.
    const dir = await agentDir({
      "channels/stubborn.mjs": `export default { name: "stubborn", connect: (ctx, signal) => ({
        ready: Promise.resolve(),
        closed: new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("shutdown failed")), { once: true })),
      }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {} });
    await service.ready;
    await expect(service.close()).rejects.toThrow(/shutdown failed/);
  });

  it("closing while a connection is still dialling rejects `ready` rather than claiming success", async () => {
    // The contract lets a connection settle `ready` as CANCELLATION on abort. Resolving normally
    // would tell the caller its channels are up while the surface is shut and health says 503.
    const dir = await agentDir({
      "channels/slow.mjs": `export default { name: "slow", connect: (ctx, signal) => ({
        ready: new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
        closed: new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
      }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {} });
    await service.close(); // while it is still dialling
    await expect(service.ready).rejects.toThrow(/closed before it became ready/);
  });

  it("`ready` resolves immediately when there are no long connections", async () => {
    const service = await createAgentService(await agentDir());
    try {
      await expect(service.ready).resolves.toBeUndefined();
      expect((await service.handler(new Request("http://h/health"))).status).toBe(200);
    } finally {
      await service.close();
    }
  });

  it("an invalid route is refused before any resource starts", async () => {
    // A configuration error must not arrive after channels are dialling: the caller has no surface
    // to close at that point. (The route language happens to be enforced earlier still, at channel
    // load — this asserts the property, not which check catches it.)
    const dir = await agentDir({
      "channels/bad.mjs": `export default () => ({ "GET /files/:id": () => new Response("x") });`,
      "channels/sock.mjs": `export default { name: "sock", connect: () => { globalThis.__faConnected = true; return {
        ready: Promise.resolve(), closed: new Promise(() => {}) }; } };`,
    });
    (globalThis as Record<string, unknown>).__faConnected = false;
    await expect(createAgentService(dir)).rejects.toThrow(/channel setup is invalid|literal path/);
    expect((globalThis as unknown as { __faConnected?: boolean }).__faConnected).toBe(false);
  });

  it("a broken schedule rejects instead of killing the host process", async () => {
    // The library must not decide an embedder's app should die. `startSchedules` used to exit(1)
    // here, which for a mounted surface means taking down someone else's server. A single bad
    // schedule FILE is isolated on purpose (G2); this is the whole-load fault that is not.
    const dir = await agentDir();
    await writeFile(join(dir, "schedules"), "not a directory\n"); // readdir fails on it
    await expect(createAgentService(dir)).rejects.toThrow(/ENOTDIR|not a directory/i);
  });

  it("surfaces a broken channel at open, rather than serving without it", async () => {
    const dir = await agentDir({ "channels/bad.mjs": `throw new Error("boom at import");` });
    await expect(createAgentService(dir)).rejects.toThrow(/channel setup is invalid|boom at import/);
  });
});
