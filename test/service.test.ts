/**
 * The product's assembly, end to end: a directory becomes a mounted handler.
 *
 * These are the properties an embedder gets for free by calling one function instead of composing
 * the parts. Each was, at some point, composed wrong — inside this repo's own CLI.
 */
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getEventListeners } from "node:events";
import { log } from "../src/log.ts";
import { describe, expect, it, vi } from "vitest";
import { createAgentService } from "../src/engines/pi/service.ts";
import { mountAgentService } from "../src/service.ts";
import { createPiAgentFromDir } from "../src/engines/pi/open.ts";

async function agentDir(
  files: Record<string, string> = {},
  config = `{ model: "openai-codex/gpt-5.5" }`,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-surface-"));
  await writeFile(join(dir, "fastagent.config.ts"), `export default ${config};\n`);
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
      // The DATA plane is there BESIDE the channel, not instead of it: `/invoke` is the framework's
      // interface, so whether a definition happens to declare a channel cannot decide if it exists.
      // 415 rather than 404: the route is mounted and refusing a body it was not told is JSON.
      expect((await service.handler(new Request("http://h/invoke", { method: "POST" }))).status).toBe(415);
    } finally {
      await service.close();
    }
  });

  it("http.invoke: false withholds the data plane, and frees its path for a channel", async () => {
    // The OFF switch. Without it, upgrading published an anonymous, fully-tooled POST /invoke on the
    // public URL of every deployment that had previously only exposed a signed webhook.
    const dir = await agentDir(
      { "channels/own.mjs": `export default () => ({ "POST /invoke": () => new Response("the channel's") });` },
      `{ model: "openai-codex/gpt-5.5", http: { invoke: false } }`,
    );
    const service = await createAgentService(dir);
    try {
      expect(await (await service.handler(new Request("http://h/invoke", { method: "POST" }))).text()).toBe(
        "the channel's",
      );
      // …and the startup report knows it is not ours. `routes` says `/invoke` answers; only `ours`
      // says whether WE answer there, which is what the try-it curl and the "unauthenticated data
      // plane" warning both need.
      expect(service.unverifiedRoutes).not.toContain("POST /invoke");
      expect(service.unverifiedRoutes).toContain("GET /health");
    } finally {
      await service.close();
    }
  });

  it("refuses an embedder's unusable cors origin, like the config file's", async () => {
    // `allowedOrigin` compares exact strings, so one trailing slash is a rule that matches nothing —
    // the front end gets 403 and nothing points at the list. `loadConfig` already refused this; the
    // MountableAgent path is the other way in and had no check at all.
    const dir = await agentDir();
    const opened = await createPiAgentFromDir(dir, { serving: true });
    await expect(mountAgentService({ ...opened, corsOrigins: ["https://app.example.com/"] })).rejects.toThrow(
      /mountAgentService: corsOrigins entry "https:\/\/app\.example\.com\/" is not the origin a browser sends/,
    );
  });

  it("publishes the control plane at its prefix, unauthenticated", async () => {
    // An embedded surface has no port of its own to advertise, so the prefix is all a client needs.
    // Nothing gates it: fastagent authenticates nothing, and the embedder's own middleware is what
    // decides who may reach this handler at all.
    const dir = await mkdtemp(join(tmpdir(), "fa-surface-control-"));
    await writeFile(
      join(dir, "fastagent.config.ts"),
      `export default { model: "openai-codex/gpt-5.5", sessionControl: true };\n`,
    );
    await writeFile(join(dir, "persona.md"), "You are a test agent.\n");
    const service = await createAgentService(dir);
    expect(service.controlPrefix).toBe("/control");
    expect((await service.handler(new Request("http://h/control/capabilities"))).status).toBe(200);
    await service.close();
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

  it("does not mount a control plane the config did not ask for — the hub is still there for /stop", async () => {
    // The two halves of what `sessionControl` used to mean: a serve always has the in-process hub (a chat channel's
    // stop command reaches the live run through it), and publishing `/control/*` stays the explicit, bearer-guarded
    // decision. Nothing is minted for a plane that is not served.
    const dir = await agentDir({
      "channels/probe.mjs": `export default ({ control }) => ({ "GET /has-control": () => new Response(String(!!control)) });`,
    });
    const service = await createAgentService(dir);
    try {
      expect((await service.handler(new Request("http://h/control/capabilities"))).status).toBe(404);
      expect(service.controlPrefix).toBeUndefined();
      // The half that is easy to lose silently: the channel still got the hub. Tightening `routesFor` to
      // `publishControl` would leave every assertion above green while `/stop` stopped working.
      expect(await (await service.handler(new Request("http://h/has-control"))).text()).toBe("true");
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

  it("concurrent close calls share completion and failure, resolved or rejected", async () => {
    for (const reject of [false, true]) {
      const dir = await agentDir({
        "channels/sock.mjs": `export let stopped = false;
        export default { name: "sock", connect: (ctx, signal) => ({
          ready: Promise.resolve(),
          closed: new Promise((resolve, reject) => signal.addEventListener("abort", () => {
            setTimeout(() => { stopped = true; ${reject ? 'reject(new Error("shutdown failed"))' : "resolve()"}; }, 30);
          }, { once: true })),
        }) };`,
      });
      const channel = await import(pathToFileURL(join(dir, "channels/sock.mjs")).href);
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

  it("close() stops the self-scheduling poll timer", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const service = await createAgentService(
      await agentDir({}, `{ model: "openai-codex/gpt-5.5", selfSchedule: true }`),
    );
    try {
      const polls = timers.mock.calls.flatMap((args, i) => (args[1] === 30_000 ? [timers.mock.results[i]?.value] : []));
      expect(polls).toHaveLength(1);
      await service.close();
      expect(cleared).toHaveBeenCalledWith(polls[0]);
    } finally {
      await service.close();
      timers.mockRestore();
      cleared.mockRestore();
    }
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

  it("an already-aborted signal rejects readiness without long connections", async () => {
    const service = await createAgentService(await agentDir(), { signal: AbortSignal.abort() });
    await expect(service.ready).rejects.toThrow("service closed before it became ready");
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

  it("a connect() that throws rolls back the connections already open", async () => {
    // The rollback path (a synchronous throw from `connect`), where the cleanup can ALSO fail: the
    // caller must still get the reason the start failed, not the aftermath of tearing it down.
    (globalThis as Record<string, unknown>).__faRolledBack = false;
    const dir = await agentDir({
      "channels/a-first.mjs": `export default { name: "a-first", connect: (ctx, signal) => ({
        ready: Promise.resolve(),
        closed: new Promise((resolve) => signal.addEventListener("abort", () => {
          globalThis.__faRolledBack = true; resolve();
        }, { once: true })),
      }) };`,
      "channels/b-throws.mjs": `export default { name: "b-throws", connect: () => { throw new Error("cannot dial"); } };`,
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
      "channels/a-first.mjs": `export default { name: "a-first", connect: (ctx, signal) => ({
        ready: Promise.reject(new Error("first dial failed")),
        closed: new Promise(resolve => signal.addEventListener("abort", () => setTimeout(resolve, 10), { once: true })),
      }) };`,
      "channels/b-throws.mjs": `export default { name: "b-throws", connect: () => { throw new Error("cannot dial"); } };`,
    });
    await expect(createAgentService(dir)).rejects.toThrow("cannot dial");
  });

  it("rejects an invalid ready OR closed promise and rolls back earlier connections", async () => {
    for (const field of ["ready", "closed"]) {
      const dir = await agentDir({
        "channels/a-first.mjs": `export default { name: "a-first", connect: (ctx, signal) => ({
          ready: Promise.resolve(),
          closed: new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("rollback reached first")), { once: true })),
        }) };`,
        "channels/b-invalid.mjs": `export default { name: "b-invalid", connect: () => ({
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
      "channels/sock.mjs": `export default { name: "sock", connect: () => ({
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
      expect((await service.handler(new Request("http://h/health"))).status).toBe(503);
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
      "channels/doomed.mjs": `export default { name: "doomed", connect: () => ({
        ready: Promise.reject(new Error("dial refused")),
        closed: Promise.reject(new Error("and could not stop either")),
      }) };`,
    });
    const service = await createAgentService(dir, { onChannelClosed: () => {} });
    await expect(service.ready).rejects.toThrow(/dial refused/);
  });

  it("closing an unresponsive dialing channel also settles ready", async () => {
    const dir = await agentDir({
      "channels/deaf.mjs": `export default { name: "deaf", connect: () => ({
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
          `channels/${name}.mjs`,
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
    // The wording carries the deadline that fired, so `closeTimeoutMs` is pinned, not just the name.
    expect(String(error)).toMatch(/did not stop within 200ms: deaf/);
    expect(String(error)).not.toMatch(/quick/);
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
      "channels/bad.mjs": `export default () => ({ "GET /a/../x": () => new Response("x") });`,
      "channels/sock.mjs": `export default { name: "sock", connect: () => { globalThis.__faConnected = true; return {
        ready: Promise.resolve(), closed: new Promise(() => {}) }; } };`,
    });
    (globalThis as Record<string, unknown>).__faConnected = false;
    await expect(createAgentService(dir)).rejects.toThrow(/failed to load|arrives as/);
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

  it("refuses to serve while a schedule's declared secret has no value", async () => {
    // A schedule reads its env at IMPORT time, so an unset value has already produced a broken
    // prompt by the time the scheduler starts — this is the last point it is still a startup failure
    // rather than a wrong turn at 9am.
    const dir = await agentDir({
      "schedules/digest.mjs": `export default { cron: "0 9 * * *", prompt: "d", secrets: ["FA_TEST_DIGEST_CHANNEL"] };`,
    });
    delete process.env.FA_TEST_DIGEST_CHANNEL;
    await expect(createAgentService(dir)).rejects.toThrow(/FA_TEST_DIGEST_CHANNEL \(schedules\/digest\.mjs\)/);
  });

  it("surfaces a broken channel at open, rather than serving without it", async () => {
    const dir = await agentDir({ "channels/bad.mjs": `throw new Error("boom at import");` });
    await expect(createAgentService(dir)).rejects.toThrow(/failed to load: channels\/bad\.mjs \(boom at import/);
  });

  it("an enabled tool or schedule that cannot load refuses the service, like a channel does", async () => {
    // The same declaration used to get a different guarantee per directory: a broken channel stopped the boot, a
    // broken tool or schedule became one warning and a service that reported itself ready — with the cron never
    // firing and the model never seeing the tool. Absent directories stay valid; `*.disabled` is the opt-out.
    for (const file of ["tools/broken.mjs", "schedules/digest.mjs"]) {
      const dir = await agentDir({ [file]: `throw new Error("missing target");` });
      await expect(createAgentService(dir)).rejects.toThrow(
        new RegExp(`failed to load: ${file.replace(".", "\\.")} \\(missing target`),
      );
      // Renaming it to the disabled form is how an author says they meant it.
      await rename(join(dir, file), join(dir, `${file}.disabled`));
      const service = await createAgentService(dir);
      await service.close();
    }
  });
});

describe("the opener feeds the assembly what the assembly reads", () => {
  it("carries selfSchedule from the config into the mounted service", async () => {
    // MountableAgent asks for `selfSchedule`; a pi opener that does not answer leaves the wake pump
    // off while the config says it is on — silently, since nothing else changes.
    const dir = await agentDir({}, `{ model: "openai-codex/gpt-5.5", selfSchedule: true }`);
    const opened = await createPiAgentFromDir(dir, { serving: true });
    expect(opened.selfSchedule).toBe(true);
  });

  it("leaves it off when the config does not ask", async () => {
    const opened = await createPiAgentFromDir(await agentDir(), { serving: true });
    expect(opened.selfSchedule).toBe(false);
  });
});
