/**
 * The product's assembly, end to end: a directory becomes a mounted handler.
 *
 * These are the properties an embedder gets for free by calling one function instead of composing
 * the parts. Each was, at some point, composed wrong — inside this repo's own CLI.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openAgentSurface } from "../src/surface.ts";

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

describe("openAgentSurface", () => {
  it("mounts channel routes on a handler, with health beside them", async () => {
    const dir = await agentDir({
      "channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("from-channel") });`,
    });
    const surface = await openAgentSurface(dir);
    try {
      expect(await (await surface.handler(new Request("http://h/hook", { method: "POST" }))).text()).toBe(
        "from-channel",
      );
      expect((await surface.handler(new Request("http://h/health"))).status).toBe(200);
      expect(surface.channels.routes).toEqual(["hook"]);
      // A declared channel replaces the built-in /invoke — the fallback exists only when there is none.
      expect((await surface.handler(new Request("http://h/invoke", { method: "POST" }))).status).toBe(404);
    } finally {
      await surface.close();
    }
  });

  it("falls back to POST /invoke when the directory declares no channel", async () => {
    const dir = await agentDir();
    const surface = await openAgentSurface(dir);
    try {
      // 400 rather than 404: the route is mounted and rejecting an empty body.
      expect((await surface.handler(new Request("http://h/invoke", { method: "POST" }))).status).toBe(400);
    } finally {
      await surface.close();
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
    const surface = await openAgentSurface(dir);
    try {
      // 401, not 404: the plane is mounted and asking for the token it minted.
      expect((await surface.handler(new Request("http://h/control/capabilities"))).status).toBe(401);
      expect(surface.mounts.map((m) => m.prefix)).toEqual(["/control"]);
    } finally {
      await surface.close();
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
    const surface = await openAgentSurface(dir);
    expect(surface.control?.prefix).toBe("/control");
    expect(surface.control?.token).toMatch(/[0-9a-f-]{36}/);
    // The token actually opens the plane it came from.
    const res = await surface.handler(
      new Request("http://h/control/capabilities", { headers: { authorization: `Bearer ${surface.control?.token}` } }),
    );
    expect(res.status).toBe(200);

    surface.announce(8787);
    const discovery = join(surface.agentDir, ".state", "control.json");
    expect(JSON.parse(await readFile(discovery, "utf8"))).toMatchObject({ token: surface.control?.token });
    await surface.close();
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
    const surface = await openAgentSurface(dir, { onChannelClosed: () => {} });
    try {
      await surface.ready;
      expect((await surface.handler(new Request("http://h/health"))).status).toBe(200);
      (globalThis as unknown as { __faDropSock?: () => void }).__faDropSock?.(); // the channel drops
      await new Promise((r) => setTimeout(r, 20));
      expect((await surface.handler(new Request("http://h/health"))).status).toBe(503);
    } finally {
      await surface.close();
    }
  });

  it("does not mount a control plane the config did not ask for", async () => {
    const surface = await openAgentSurface(await agentDir());
    try {
      expect(surface.mounts).toEqual([]);
      expect((await surface.handler(new Request("http://h/control/capabilities"))).status).toBe(404);
    } finally {
      await surface.close();
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
    const surface = await openAgentSurface(dir);
    expect(surface.channels.longConnections).toEqual(["sock"]);
    await surface.close();
    expect((globalThis as Record<string, unknown>).__faSockClosed).toBe(true);
    await expect(surface.close()).resolves.toBeUndefined(); // idempotent
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
    const surface = await openAgentSurface(dir, { signal: AbortSignal.abort() });
    expect((globalThis as Record<string, unknown>).__faAbortedClosed).toBe(true);
    await surface.close();
  });

  it("closes on its own signal, and close() is idempotent", async () => {
    const controller = new AbortController();
    const surface = await openAgentSurface(await agentDir(), { signal: controller.signal });
    controller.abort();
    await expect(surface.close()).resolves.toBeUndefined();
    await expect(surface.close()).resolves.toBeUndefined();
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
    const surface = await openAgentSurface(dir);
    await expect(surface.ready).rejects.toThrow(/dial refused/);
    expect((globalThis as Record<string, unknown>).__faFailClosed).toBe(true); // torn down, not left up
    // Health never flipped to 200: the surface must not advertise itself as serving.
    expect((await surface.handler(new Request("http://h/health"))).status).toBe(503);
  });

  it("`ready` resolves immediately when there are no long connections", async () => {
    const surface = await openAgentSurface(await agentDir());
    try {
      await expect(surface.ready).resolves.toBeUndefined();
      expect((await surface.handler(new Request("http://h/health"))).status).toBe(200);
    } finally {
      await surface.close();
    }
  });

  it("surfaces a broken channel at open, rather than serving without it", async () => {
    const dir = await agentDir({ "channels/bad.mjs": `throw new Error("boom at import");` });
    await expect(openAgentSurface(dir)).rejects.toThrow(/channel setup is invalid|boom at import/);
  });
});
