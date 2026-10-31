/**
 * The product's assembly, end to end: a directory becomes a mounted handler.
 *
 * These are the properties an embedder gets for free by calling one function instead of composing
 * the parts. Each was, at some point, composed wrong — inside this repo's own CLI.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { log } from "../src/log.ts";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import { openAgent, openServing } from "../src/harnesses/pi-durable/serve.ts";
import { connectAgent } from "../src/http/client.ts";
import { type ServeOptions, serveAgent } from "../src/service.ts";
import { CODEX_MODEL } from "./codex-model.ts";

const opened: DurableAgent[] = [];
afterAll(async () => {
  for (const agent of opened) await agent.close();
});

/** The directory opened as a serve opens it, with no storage of its own, and mounted. */
async function createAgentService(dir: string, options: ServeOptions = {}) {
  const served = await openServing(dir, { storage: "memory" });
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
  it("opens a directory named by a relative path at its absolute location", async () => {
    // The prompt names the agent's files and working directory by these, and its tools resolve a relative one
    // against that working directory.
    const dir = await agentDir();
    const served = await openServing(relative(process.cwd(), dir), { storage: "memory" });
    opened.push(served.agent);
    expect([served.agentDir, served.definition.dir]).toEqual([dir, dir]);
  });

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

  it("a connection that dies after coming up makes health say so again", async () => {
    // Readiness is two-way: the surface would otherwise keep telling a load balancer it serves a
    // channel it no longer has.
    const dir = await agentDir({
      "src/channels/sock.mjs": `let end; export default {
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
      expect((await service.fetch(new Request("http://h/health"))).status).toBe(200);
      (globalThis as unknown as { __faDropSock?: () => void }).__faDropSock?.(); // the channel drops
      await new Promise((r) => setTimeout(r, 20));
      expect((await service.fetch(new Request("http://h/health"))).status).toBe(503);
    } finally {
      await service.close();
    }
  });

  it("a drop during startup fails startup, whatever the other connections do", async () => {
    // Interleaving: one channel dies while another is still dialling. Startup must FAIL — resolving
    // `ready` while health is permanently 503 would answer the same question two ways.
    (globalThis as Record<string, unknown>).__faSlowReady = undefined;
    const dir = await agentDir({
      "src/channels/dies.mjs": `export default { name: "dies", connect: () => ({
        ready: Promise.resolve(), closed: Promise.resolve() }) };`,
      "src/channels/slow.mjs": `export default { name: "slow", connect: (ctx, signal) => ({
        ready: new Promise((r) => { globalThis.__faSlowReady = r; }),
        closed: new Promise((r) => signal.addEventListener("abort", () => r(), { once: true })),
      }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {} });
    try {
      await new Promise((r) => setTimeout(r, 20)); // let "dies" report closed
      (globalThis as unknown as { __faSlowReady?: () => void }).__faSlowReady?.();
      await expect(service.ready).rejects.toThrow(/closed before startup completed/);
      expect((await service.fetch(new Request("http://h/health"))).status).toBe(503);
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
      "src/channels/sock.mjs": `export default {
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

  it("concurrent close calls share completion and failure, resolved or rejected", async () => {
    for (const reject of [false, true]) {
      const dir = await agentDir({
        "src/channels/sock.mjs": `export default { name: "sock", connect: (ctx, signal) => ({
          ready: Promise.resolve(),
          closed: new Promise((resolve, reject) => signal.addEventListener("abort", () => {
            setTimeout(() => { globalThis.__faSockStopped = true; ${reject ? 'reject(new Error("shutdown failed"))' : "resolve()"}; }, 30);
          }, { once: true })),
        }) };`,
      });
      // Observed through a global: the channel module is loaded by the agent's registry, not by this test.
      const channel = {
        get stopped() {
          return (globalThis as Record<string, unknown>).__faSockStopped === true;
        },
      };
      (globalThis as Record<string, unknown>).__faSockStopped = false;
      const service = await createAgentService(dir);
      await service.ready;
      const first = service.close().finally(() => {
        expect(channel.stopped).toBe(true);
      });
      const second = service.close().finally(() => {
        expect(channel.stopped).toBe(true);
      });
      const results = await Promise.allSettled([first, second]);
      const label = reject ? "rejected" : "resolved";
      if (reject) {
        const [a, b] = results as PromiseRejectedResult[];
        expect(a?.status, label).toBe("rejected");
        expect(b?.reason, label).toBe(a?.reason);
        await expect(service.close(), label).rejects.toBe(a?.reason);
      } else {
        expect(results, label).toEqual([
          { status: "fulfilled", value: undefined },
          { status: "fulfilled", value: undefined },
        ]);
      }
    }
  });

  it("every serve polls the agent's own wake-ups — no switch — and close() stops it", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const service = await createAgentService(await agentDir({}, `{ model: "${CODEX_MODEL}" }`));
    try {
      const polls = timers.mock.calls.flatMap((args, i) => (args[1] === 30_000 ? [timers.mock.results[i]?.value] : []));
      expect(polls).toHaveLength(1);
      await service.close();
      for (const poll of polls) expect(cleared).toHaveBeenCalledWith(poll);
    } finally {
      await service.close();
      timers.mockRestore();
      cleared.mockRestore();
    }
  });

  it("close() is idempotent", async () => {
    const service = await createAgentService(await agentDir());
    await expect(service.close()).resolves.toBeUndefined();
    await expect(service.close()).resolves.toBeUndefined();
  });

  it("a long connection that cannot come up rejects `ready` and tears the surface down", async () => {
    // Not a degraded surface: a declared channel that is dead means this deployment is not serving
    // what it was configured to serve. `ready` carries that to the caller — the CLI fails startup,
    // an embedder gets a rejection it can handle — and nothing is left running behind it.
    (globalThis as Record<string, unknown>).__faFailClosed = false;
    const dir = await agentDir({
      "src/channels/sock.mjs": `export default {
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
    expect((await service.fetch(new Request("http://h/health"))).status).toBe(503);
  });

  it("a connection that dies while dialling fails startup instead of hanging it", async () => {
    // The contract puts a terminal failure on `closed`, and a channel that dies before connecting
    // may never settle `ready`. Waiting on `ready` alone hangs open() forever with no diagnosis.
    const dir = await agentDir({
      "src/channels/stuck.mjs": `export default { name: "stuck", connect: () => ({
        ready: new Promise(() => {}),
        closed: Promise.reject(new Error("dial refused")),
      }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {} });
    await expect(service.ready).rejects.toThrow(/stuck failed before it was ready|dial refused/);
  });

  it("a connect() that throws rolls back the connections already open", async () => {
    // The rollback path (a synchronous throw from `connect`), where the cleanup can ALSO fail: the
    // caller must still get the reason the start failed, not the aftermath of tearing it down.
    (globalThis as Record<string, unknown>).__faRolledBack = false;
    const dir = await agentDir({
      "src/channels/a-first.mjs": `export default { name: "a-first", connect: (ctx, signal) => ({
        ready: Promise.resolve(),
        closed: new Promise((resolve) => signal.addEventListener("abort", () => {
          globalThis.__faRolledBack = true; resolve();
        }, { once: true })),
      }) };`,
      "src/channels/b-throws.mjs": `export default { name: "b-throws", connect: () => { throw new Error("cannot dial"); } };`,
    });
    await expect(createAgentService(dir, { onChannelClosed: () => {}, closeTimeoutMs: 200 })).rejects.toThrow(
      /cannot dial/,
    );
    // Asserted, not assumed: rollback catches everything, so a cleanup that threw its way out would
    // still surface the right message while having done nothing.
    expect((globalThis as unknown as { __faRolledBack?: boolean }).__faRolledBack).toBe(true);
  });

  it("observes a ready rejection when a later connect throws", async () => {
    const dir = await agentDir({
      "src/channels/a-first.mjs": `export default { name: "a-first", connect: (ctx, signal) => ({
        ready: Promise.reject(new Error("first dial failed")),
        closed: new Promise(resolve => signal.addEventListener("abort", () => setTimeout(resolve, 10), { once: true })),
      }) };`,
      "src/channels/b-throws.mjs": `export default { name: "b-throws", connect: () => { throw new Error("cannot dial"); } };`,
    });
    await expect(createAgentService(dir)).rejects.toThrow("cannot dial");
  });

  it("rejects an invalid ready OR closed promise and rolls back earlier connections", async () => {
    for (const field of ["ready", "closed"]) {
      const dir = await agentDir({
        "src/channels/a-first.mjs": `export default { name: "a-first", connect: (ctx, signal) => ({
          ready: Promise.resolve(),
          closed: new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("rollback reached first")), { once: true })),
        }) };`,
        "src/channels/b-invalid.mjs": `export default { name: "b-invalid", connect: () => ({
          ready: Promise.resolve(), closed: Promise.resolve(), ${field}: null,
        }) };`,
      });
      const logged = vi.spyOn(log, "error").mockImplementation(() => {});
      try {
        await expect(createAgentService(dir), field).rejects.toThrow("b-invalid connect(signal) must return");
        expect(logged, field).toHaveBeenCalledWith(expect.stringContaining("rollback reached first"));
      } finally {
        logged.mockRestore();
      }
    }
  });

  it("logs a throwing closure callback and still rolls back startup", async () => {
    const dir = await agentDir({
      "src/channels/sock.mjs": `export default { name: "sock", connect: () => ({
        ready: new Promise(() => {}), closed: Promise.resolve(),
      }) };`,
    });
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const service = await createAgentService(dir, {
        onChannelClosed: () => {
          throw new Error("callback broke");
        },
      });
      await expect(service.ready).rejects.toThrow("sock closed before it was ready");
      expect((await service.fetch(new Request("http://h/health"))).status).toBe(503);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("callback broke"));
      await service.close();
    } finally {
      logged.mockRestore();
    }
  });

  it("a failed start reports the start failure, not the cleanup's", async () => {
    // Both fail here: the connection cannot come up AND cannot stop. The caller needs the first —
    // the second is the aftermath, and replacing one with the other hides the actual cause.
    const dir = await agentDir({
      "src/channels/doomed.mjs": `export default { name: "doomed", connect: () => ({
        ready: Promise.reject(new Error("dial refused")),
        closed: Promise.reject(new Error("and could not stop either")),
      }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {} });
    await expect(service.ready).rejects.toThrow(/dial refused/);
  });

  it("closing an unresponsive dialing channel also settles ready", async () => {
    const dir = await agentDir({
      "src/channels/deaf.mjs": `export default { name: "deaf", connect: () => ({
        ready: new Promise(() => {}), closed: new Promise(() => {}),
      }) };`,
    });
    const service = await createAgentService(dir, { closeTimeoutMs: 20 });
    await expect(service.close()).rejects.toThrow("did not stop within 20ms: deaf");
    await expect(service.ready).rejects.toThrow("service closed before it became ready");
  });

  // `closed` carries a terminal failure by contract: swallowing one would let `close()` claim the
  // surface is stopped over a channel that did not stop, and the caller could never tell.
  it("reports close failures, aggregated after all connections settle", async () => {
    const dir = await agentDir(
      Object.fromEntries(
        ["a", "b"].map((name) => [
          `src/channels/${name}.mjs`,
          `export default { name: "${name}", connect: (ctx, signal) => ({
        ready: Promise.resolve(),
        closed: new Promise((_, reject) => signal.addEventListener("abort", () => {
          setTimeout(() => reject(new Error("${name} failed to stop")), ${name === "a" ? 5 : 20});
        }, { once: true })),
      }) };`,
        ]),
      ),
    );
    const service = await createAgentService(dir);
    await service.ready;
    const error = await service.close().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "a failed to stop",
      "b failed to stop",
    ]);
  });

  it("a channel that ignores its abort signal cannot hang teardown, and only IT is named", async () => {
    // `closed` never settles for `deaf`, so without a deadline `close()` waits forever. And a shutdown
    // message that blames every channel because one hung sends the reader to the wrong file: the
    // deadline reports what did not settle, individually.
    const dir = await agentDir({
      "src/channels/quick.mjs": `export default { name: "quick", connect: (ctx, signal) => ({
        ready: Promise.resolve(),
        closed: new Promise((r) => signal.addEventListener("abort", () => r(), { once: true })),
      }) };`,
      "src/channels/deaf.mjs": `export default { name: "deaf", connect: () => ({
        ready: Promise.resolve(), closed: new Promise(() => {}) }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {}, closeTimeoutMs: 200 });
    await service.ready;
    const error = await service.close().catch((e: Error) => e);
    // The wording carries the deadline that fired, so `closeTimeoutMs` is pinned, not just the name.
    expect(String(error)).toMatch(/did not stop within 200ms: deaf/);
    expect(String(error)).not.toMatch(/quick/);
  });

  it("closing while a connection is still dialling rejects `ready` rather than claiming success", async () => {
    // The contract lets a connection settle `ready` as CANCELLATION on abort. Resolving normally
    // would tell the caller its channels are up while the surface is shut and health says 503.
    const dir = await agentDir({
      "src/channels/slow.mjs": `export default { name: "slow", connect: (ctx, signal) => ({
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
      expect((await service.fetch(new Request("http://h/health"))).status).toBe(200);
    } finally {
      await service.close();
    }
  });

  it("an invalid route is refused before any resource starts", async () => {
    // A configuration error must not arrive after channels are dialling: the caller has no surface
    // to close at that point. (The route language happens to be enforced earlier still, at channel
    // load — this asserts the property, not which check catches it.)
    const dir = await agentDir({
      "src/channels/bad.mjs": `export default () => ({ "GET /a/../x": () => new Response("x") });`,
      "src/channels/sock.mjs": `export default { name: "sock", connect: () => { globalThis.__faConnected = true; return {
        ready: Promise.resolve(), closed: new Promise(() => {}) }; } };`,
    });
    (globalThis as Record<string, unknown>).__faConnected = false;
    await expect(createAgentService(dir)).rejects.toThrow(/arrives as/);
    expect((globalThis as unknown as { __faConnected?: boolean }).__faConnected).toBe(false);
  });

  it("surfaces a broken channel or tool at open, rather than serving without it", async () => {
    for (const file of ["src/channels/bad.mjs", "src/tools/bad.mjs"]) {
      const dir = await agentDir({ [file]: `throw new Error("boom at import");` });
      await expect(createAgentService(dir), file).rejects.toThrow(/loading src\/ through .*boom at import/);
    }
  });
});

describe("openAgent: an agent directory opened in an app", () => {
  it("serves the Agent API under /v1 beside its routes only with a key, and keeps /v1 from a channel", async () => {
    const dir = await agentDir();
    const unkeyed = await openAgent(dir);
    const plain = await unkeyed.serve();
    expect((await plain.fetch(new Request("http://app/v1/agent"))).status).toBe(404);
    await unkeyed.close();

    const keyed = await openAgent(dir);
    const service = await keyed.serve({ apiKeys: ["k"] });
    const info = await service.fetch(new Request("http://app/v1/agent", { headers: { authorization: "Bearer k" } }));
    expect(await info.json()).toMatchObject({ name: expect.any(String) });
    expect((await service.fetch(new Request("http://app/v1/agent"))).status).toBe(401);
    expect((await service.fetch(new Request("http://app/health"))).status).toBe(200);
    await keyed.close();

    const watched = await openAgent(dir);
    const listening = await watched.serve({ apiKeys: ["k"] });
    const port = await listening.listen(0, "127.0.0.1");
    const { id } = await watched.sessions.create();
    const events = connectAgent(`http://127.0.0.1:${port}`, { apiKey: "k" })
      .sessions.events(id)
      [Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ type: "state" });
    const started = Date.now();
    await watched.close();
    // Ended before the server stops, so the close does not wait out the server's grace for it.
    expect(Date.now() - started).toBeLessThan(450);
    expect((await events.next()).value).toMatchObject({
      type: "stream_error",
      error: { code: "unavailable", message: "the service is closing" },
    });

    const unset = await openAgent(dir);
    await expect(unset.serve({ apiKeys: [process.env.FASTAGENT_TEST_UNSET_KEY ?? ""] })).rejects.toThrow(
      "the Agent API needs at least one key, and no key may be empty",
    );
    await unset.close();

    const claiming = await openAgent(
      await agentDir({
        "src/channels/claims.mjs": `export default () => ({ "POST /v1/hook": () => new Response("ok") });`,
      }),
    );
    await expect(claiming.serve()).rejects.toThrow('route "POST /v1/hook" is under /v1, which the Agent API serves');
    await claiming.close();
  });

  it("serves its routes in process and on a server of its own, and closes both before it lets the storage go", async () => {
    const dir = await agentDir();
    const agent = await openAgent(dir);
    const session = await agent.sessions.create();
    expect(await agent.sessions.get(session.id)).toMatchObject({ id: session.id, status: "idle" });

    const service = await agent.serve();
    expect((await service.fetch(new Request("http://app/health"))).status).toBe(200);
    expect((await service.fetch(new Request("http://app/nope"))).status).toBe(404);
    await expect(agent.serve()).rejects.toThrow("this agent is already served");

    const port = await service.listen(0, "127.0.0.1");
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    await expect(service.listen(0, "127.0.0.1")).rejects.toThrow("the service is already listening");

    await agent.close();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    // The instance's storage is free again: another process (here, another open) may hold it.
    const again = await openAgent(dir);
    expect(await again.sessions.get(session.id)).toMatchObject({ id: session.id });
    await again.close();
  });

  it("refuses to serve once it is closed, or while it closes: nothing would close that service", async () => {
    const dir = await agentDir();
    const closed = await openAgent(dir);
    await closed.close();
    await expect(closed.serve()).rejects.toThrow("this agent is closed");
    const closing = await openAgent(dir);
    const going = closing.close();
    await expect(closing.serve()).rejects.toThrow("this agent is closed");
    await going;
  });

  it("serves again after a serve that failed to start, and listens again after a bind that failed", async () => {
    const flag = globalThis as Record<string, unknown>;
    flag.__faFailServe = true;
    const agent = await openAgent(
      await agentDir({
        "src/channels/flaky.mjs": `export default () => {
          if (globalThis.__faFailServe) throw new Error("dial refused");
          return { "POST /flaky": () => new Response("ok") };
        };`,
      }),
    );
    try {
      await expect(agent.serve()).rejects.toThrow("dial refused");
      flag.__faFailServe = false;
      const service = await agent.serve();
      const taken = await service.listen(0, "127.0.0.1");
      const other = await openAgent(await agentDir());
      try {
        const second = await other.serve();
        await expect(second.listen(taken, "127.0.0.1")).rejects.toMatchObject({ code: "EADDRINUSE" });
        const port = await second.listen(0, "127.0.0.1");
        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      } finally {
        await other.close();
      }
    } finally {
      delete flag.__faFailServe;
      await agent.close();
    }
  });
});
