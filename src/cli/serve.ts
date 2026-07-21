/**
 * The serving spine shared by `dev` (its worker) and `start`: channel assembly, Node HTTP binding,
 * long-connection lifecycle, scheduler lifecycle, and the optional Cloudflare quick tunnel.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../agent.ts";
import { controlRoutes } from "../channels/control.ts";
import { INVOKE_EXAMPLE_BODY, createInvokeHandler } from "../channels/http.ts";
import { text } from "../channels/respond.ts";
import { type LoadedLongConnectionChannel, loadChannels } from "../engines/pi/channel.ts";
import { reportModuleLoadFailures } from "../engines/pi/report.ts";
import { type Routes, parseRouteKey, router, serveNode } from "../host/node.ts";
import { log } from "../log.ts";
import { openExternalUrl } from "../open-url.ts";
import { loadSchedules } from "../schedule/discover.ts";
import { createScheduler } from "../schedule/scheduler.ts";
import type { SessionControl } from "../session.ts";
import { announceWebhooks, startCloudflareTunnel } from "../tunnel.ts";
import { failStartup } from "./fail.ts";

export interface ServingSurface {
  routes: Routes;
  longConnections: LoadedLongConnectionChannel[];
  /** Route-channel basenames; the tunnel registers only this subset. */
  routeChannels: string[];
  builtinInvoke: boolean;
  /** Marks the built-in health route ready after every long-connection channel first connects. */
  markReady(): void;
}

/**
 * The surface this deployment serves: default `GET /health` plus discovered channels, or the default
 * POST `/invoke` only when neither a route nor a long-connection channel was declared.
 */
export async function routesFor(workspaceDir: string, agent: Agent, stateRoot: string): Promise<ServingSurface> {
  const { routes, longConnections, routeChannels, collisions, failures } = await loadChannels(workspaceDir, {
    agent,
    stateRoot,
  });
  for (const c of collisions) {
    console.error(
      `[fastagent] warn: channel route "${c.route}" (${c.source}) collides with an earlier channel — not mounted`,
    );
  }
  reportModuleLoadFailures(failures);
  if (failures.length > 0 || collisions.length > 0) {
    throw new Error(
      `channel setup is invalid (${failures.length} load failure(s), ${collisions.length} route collision(s)) — ` +
        `fix it, or rename an intentionally disabled file to *.disabled`,
    );
  }
  const builtinInvoke = Object.keys(routes).length === 0 && longConnections.length === 0;
  const channels = builtinInvoke ? { "POST /invoke": createInvokeHandler(agent) } : routes;
  const healthCovered = Object.keys(channels).some((key) => {
    const entry = parseRouteKey(key);
    return entry.path === "/health" && (entry.method === undefined || entry.method === "GET");
  });
  let ready = longConnections.length === 0;
  const health = (): Response => (ready ? text("ok\n", 200) : text("starting\n", 503));
  return {
    routes: healthCovered ? channels : { "GET /health": health, ...channels },
    longConnections,
    routeChannels,
    builtinInvoke,
    markReady() {
      ready = true;
    },
  };
}

/**
 * Mount the session control plane (`/control/*`) when the workspace enabled it
 * (`config.sessionControl`): merge the bearer-authenticated routes and return an announcer that
 * writes `<stateRoot>/control.json` — `{ url, token }`, 0600 — once the port is known. The file is
 * the LOCAL discovery channel (`fastagent attach`, a local desktop app); filesystem permissions are
 * its trust boundary, and each boot overwrites it with a fresh per-boot token. A user channel
 * colliding on `/control/*` fails startup — the same disposition as a channel-channel collision
 * (routesFor): `sessionControl` is an explicit opt-in, so declaring both is a configuration error,
 * and silently shadowing either side would serve a surface the author didn't write.
 */
export function mountSessionControl(
  routes: Routes,
  control: SessionControl | undefined,
  stateRoot: string,
  options: { tunnel?: boolean; agent?: Agent } = {},
): { routes: Routes; announce: (boundPort: number) => void } {
  if (!control) return { routes, announce: () => {} };
  const token = crypto.randomUUID();
  const mounted = controlRoutes(control, { token, agent: options.agent });
  // PATH-level collision, matching the router's semantics (an any-method "/control/dispatch"
  // channel key would dodge an exact-key check yet still shadow the method-qualified control
  // route at match time — the router matches by path first).
  const mountedPaths = new Set(Object.keys(mounted).map((key) => parseRouteKey(key).path));
  const collisions = Object.keys(routes).filter((key) => mountedPaths.has(parseRouteKey(key).path));
  if (collisions.length > 0) {
    throw new Error(
      `channel route(s) ${collisions.map((key) => `"${key}"`).join(", ")} collide with the session control plane — ` +
        `rename the channel route or disable sessionControl in fastagent.config`,
    );
  }
  return {
    routes: { ...routes, ...mounted },
    announce: (boundPort) => {
      // The state root normally exists (the opener mkdirs the sessions dir under it), but an
      // external --sessions-dir leaves it uncreated — and announce runs inside serve's listening
      // callback, where a throw is an unhandled rejection, not a one-line startup diagnostic.
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const path = join(stateRoot, "control.json");
      // Atomic (tmp+rename, the state.ts pattern): attach re-reads this file exactly during the
      // restart window — a torn read would be misdiagnosed as "serve gone".
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ url: `http://127.0.0.1:${boundPort}`, token })}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600); // an existing file keeps its old mode on rewrite — pin it
      renameSync(tmp, path);
      log.info(`[fastagent] session control on /control/* (token in ${path})`);
      // The serve binds ALL interfaces (containers require it), so /control/* is LAN-reachable
      // with the bearer token as the only protection — the tunnel and deploy paths warn loudly,
      // and the LAN path must not be the silent third way past the local trust story.
      log.warn(
        "[fastagent] the port binds all interfaces: /control/* is reachable on your LAN, protected only by " +
          "the bearer token — firewall the port or wrap it for real exposure (docs: design §14)",
      );
      if (options.tunnel) {
        // Local trust = the token + its file permissions; --tunnel takes the whole port PUBLIC
        // (beyond even the LAN reach the mount already warned about). The operator asked for the tunnel (webhooks), but must not DISCOVER the control
        // plane went public with it — say it loudly.
        log.warn(
          "[fastagent] --tunnel exposes /control/* (steer/abort/set_model) at the public tunnel URL, " +
            "protected ONLY by the bearer token — wrap it with real auth before sharing that URL (docs: design §14)",
        );
      }
      // Best-effort lifecycle end: a clean exit removes the discovery file so a later `attach`
      // fails with "cannot read" (accurate) instead of a stale token's misleading 401/ECONNREFUSED.
      const unlink = (): void => {
        try {
          rmSync(path, { force: true });
        } catch {
          /* the file is advisory — exit must not fail on it */
        }
      };
      // Signal handlers MUST NOT absorb termination: registering any listener disables Node's
      // default kill, so clean up and RE-RAISE. The mechanism: `process.kill` delivery is ASYNC —
      // it lands after the current emit completes, so every listener of this same emit (scheduler
      // stop, tunnel close — regardless of registration order) runs first, and the re-raised
      // signal then hits the default action because each `once` handler is already consumed. When
      // some listener exits the process itself (the tunnel path calls process.exit(0)), the
      // re-raise is harmless redundancy. Without this, the first Ctrl+C would leave the serve
      // alive minus its control.json, and dev's watch restart (SIGTERM → wait for exit → respawn)
      // would hang on a worker that never exits.
      const unlinkAndReraise = (signal: NodeJS.Signals) => (): void => {
        unlink();
        process.kill(process.pid, signal);
      };
      process.once("SIGINT", unlinkAndReraise("SIGINT"));
      process.once("SIGTERM", unlinkAndReraise("SIGTERM"));
      process.once("exit", unlink);
    },
  };
}

/**
 * Bind HTTP, open long-connection channels, and report ready only when both forms are usable. Each
 * adapter owns reconnects; a terminal close rejects `closed` and fails the process visibly. Abort is
 * the sole clean-shutdown command.
 */
export function serve(surface: ServingSurface, port: number, onListening?: (boundPort: number) => void): void {
  const hosted = serveNode(router(surface.routes), { port });
  const abort = new AbortController();
  let stopping = false;

  const stop = (exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    const deadline = setTimeout(() => process.exit(exitCode), 1_000);
    void hosted
      .close()
      .catch(() => {})
      .finally(() => {
        clearTimeout(deadline);
        process.exit(exitCode);
      });
    // Preserve the existing no-drain shutdown contract: stop accepting first, then cut active streams.
    hosted.closeAllConnections();
  };
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));

  hosted.listening.then(
    async (boundPort) => {
      try {
        const runs = surface.longConnections.map((connection) => {
          const run = connection.connect(abort.signal);
          if (
            run === null ||
            typeof run !== "object" ||
            typeof run.ready?.then !== "function" ||
            typeof run.closed?.then !== "function"
          ) {
            throw new Error(`${connection.name} connect(signal) must return { ready: Promise, closed: Promise }`);
          }
          void run.closed.then(
            () => {
              if (!abort.signal.aborted) failStartup(new Error(`${connection.name} closed unexpectedly`));
            },
            (error) => {
              if (!abort.signal.aborted) failStartup(new Error(`${connection.name} failed: ${String(error)}`));
            },
          );
          return { connection, run };
        });
        await Promise.all(
          runs.map(async ({ connection, run }) => {
            await run.ready;
            if (!abort.signal.aborted) log.info(`[fastagent] long connection ready: ${connection.name}`);
          }),
        );
        // Shutdown raced startup: a pre-ready abort settles `ready` as cancellation, not readiness —
        // stop() already owns the exit; don't mark ready or report a surface being torn down.
        if (abort.signal.aborted) return;
        surface.markReady();
        process.send?.({
          type: "ready",
          port: boundPort,
          routeChannels: surface.routeChannels,
        });
        log.info(`[fastagent] http host on :${boundPort}`);
        log.info(`[fastagent] routes: ${Object.keys(surface.routes).join(", ") || "(none)"}`);
        if (surface.longConnections.length > 0) {
          log.info(
            `[fastagent] long connections: ${surface.longConnections.map((connection) => connection.name).join(", ")}`,
          );
        }
        if (surface.builtinInvoke) {
          log.info(
            `[fastagent] try it: curl -s localhost:${boundPort}/invoke -X POST -H 'content-type: application/json' -d '${INVOKE_EXAMPLE_BODY}'`,
          );
        }
        onListening?.(boundPort);
      } catch (error) {
        abort.abort();
        const closing = hosted.close().catch(() => {});
        hosted.closeAllConnections();
        await closing;
        failStartup(error);
      }
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE")
        failStartup(new Error(`port ${port} is already in use; choose another with --port`));
      failStartup(new Error(`cannot bind http channel on :${port}: ${error.message}`));
    },
  );
}

/** Start a Cloudflare tunnel for route channels only. */
export function maybeTunnel(workspaceDir: string, routeChannels: string[], boundPort: number, tunnel: boolean): void {
  if (!tunnel || process.env.FASTAGENT_DEV_WORKER === "1") return;
  void startCloudflareTunnel(boundPort).then((instance) => {
    if (!instance) return;
    void announceWebhooks(workspaceDir, instance.url, { openUrl: openExternalUrl, routeChannels });
    const cleanup = (): void => instance.close();
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}

/**
 * Load and start the workspace's `schedules/` — a time-trigger firing the agent on each cron. Starts iff
 * there are static schedules OR `selfSchedule` is on. Best-effort stop on process signals.
 */
export async function startSchedules(
  workspaceDir: string,
  agent: Agent,
  stateRoot: string,
  selfSchedule: boolean,
): Promise<void> {
  const { schedules, failures } = await loadSchedules(workspaceDir).catch(failStartup);
  reportModuleLoadFailures(failures);
  if (schedules.length === 0 && !selfSchedule) return;
  const scheduler = createScheduler({ agent, stateRoot, schedules });
  scheduler.start();
  if (schedules.length > 0) log.info(`[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}`);
  const stop = (): void => scheduler.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
