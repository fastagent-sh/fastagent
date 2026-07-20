/**
 * The serving spine shared by `dev` (its worker) and `start`: route assembly from discovered
 * channels/, the Node host binding, the scheduler lifecycle, and the optional Cloudflare quick
 * tunnel. Bodies moved verbatim from cli.ts; `values.tunnel` became a parameter.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../agent.ts";
import { controlRoutes } from "../channels/control.ts";
import { INVOKE_EXAMPLE_BODY, createInvokeHandler } from "../channels/http.ts";
import type { SessionControl } from "../session.ts";
import { text } from "../channels/respond.ts";
import { loadChannels } from "../engines/pi/channel.ts";
import { reportModuleLoadFailures } from "../engines/pi/report.ts";
import { type Routes, parseRouteKey, router, serveNode } from "../host/node.ts";
import { log } from "../log.ts";
import { openExternalUrl } from "../open-url.ts";
import { loadSchedules } from "../schedule/discover.ts";
import { createScheduler } from "../schedule/scheduler.ts";
import { announceWebhooks, startCloudflareTunnel } from "../tunnel.ts";
import { failStartup } from "./fail.ts";

/**
 * The routes this deployment serves: a default `GET /health` plus the workspace's discovered
 * `channels/` — or the default invoke channel at POST /invoke when none are declared.
 * `builtinInvoke` records which of the two it was: the "try it" curl hint holds only for the
 * built-in handler (a user channel at the same key may speak a different body shape).
 */
export async function routesFor(
  workspaceDir: string,
  agent: Agent,
  stateRoot: string,
): Promise<{ routes: Routes; builtinInvoke: boolean }> {
  const { routes, collisions, failures } = await loadChannels(workspaceDir, { agent, stateRoot });
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
  const builtinInvoke = Object.keys(routes).length === 0;
  const channels = builtinInvoke ? { "POST /invoke": createInvokeHandler(agent) } : routes;
  // Add a default GET /health unless a channel already covers it (overlap, not exact-key: an
  // any-method `/health` also handles GET, so the built-in steps aside).
  const healthCovered = Object.keys(channels).some((k) => {
    const e = parseRouteKey(k);
    return e.path === "/health" && (e.method === undefined || e.method === "GET");
  });
  return {
    routes: healthCovered ? channels : { "GET /health": () => text("ok\n", 200), ...channels },
    builtinInvoke,
  };
}

/**
 * Mount the session control plane (`/control/*`) when the workspace enabled it
 * (`config.sessionControl`): merge the bearer-authenticated routes and return an announcer that
 * writes `<stateRoot>/control.json` — `{ url, token }`, 0600 — once the port is known. The file is
 * the LOCAL discovery channel (`fastagent attach`, a local desktop app); filesystem permissions are
 * its trust boundary, and each boot overwrites it with a fresh per-boot token. Control routes are
 * merged LAST: a user channel colliding on `/control/*` loses, loudly.
 */
export function mountSessionControl(
  routes: Routes,
  control: SessionControl | undefined,
  stateRoot: string,
  options: { tunnel?: boolean } = {},
): { routes: Routes; announce: (boundPort: number) => void } {
  if (!control) return { routes, announce: () => {} };
  const token = crypto.randomUUID();
  const mounted = controlRoutes(control, { token });
  for (const key of Object.keys(mounted)) {
    if (key in routes) log.warn(`[fastagent] channel route "${key}" is shadowed by the control plane`);
  }
  return {
    routes: { ...routes, ...mounted },
    announce: (boundPort) => {
      // The state root normally exists (the opener mkdirs the sessions dir under it), but an
      // external --sessions-dir leaves it uncreated — and announce runs inside serve's listening
      // callback, where a throw is an unhandled rejection, not a one-line startup diagnostic.
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const path = join(stateRoot, "control.json");
      writeFileSync(path, `${JSON.stringify({ url: `http://127.0.0.1:${boundPort}`, token })}\n`, { mode: 0o600 });
      chmodSync(path, 0o600); // an existing file keeps its old mode on rewrite — pin it
      log.info(`[fastagent] session control on /control/* (token in ${path})`);
      if (options.tunnel) {
        // The safety narrative is "loopback + file permissions"; --tunnel breaks it for the whole
        // port. The operator asked for the tunnel (webhooks), but must not DISCOVER the control
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

/** Serve `routes` via the Node host. serveNode owns binding; the CLI owns policy (errors, ready signal, log). */
export function serve(
  { routes, builtinInvoke }: { routes: Routes; builtinInvoke: boolean },
  port: number,
  onListening?: (boundPort: number) => void,
): void {
  serveNode(router(routes), { port }).listening.then(
    (boundPort) => {
      process.send?.({ type: "ready", port: boundPort }); // tell the dev supervisor we bound + on which port
      log.info(`[fastagent] http channel on :${boundPort}`);
      log.info(`[fastagent] routes: ${Object.keys(routes).join(", ") || "(none)"}`);
      // Proof of life: end setup with an observable success, not an inferred one. Only for the
      // BUILT-IN invoke handler — its body ships from the http channel (INVOKE_EXAMPLE_BODY, pinned
      // by test); a user channel at the same key may speak a different shape, so no hint there.
      if (builtinInvoke) {
        log.info(
          `[fastagent] try it: curl -s localhost:${boundPort}/invoke -X POST -H 'content-type: application/json' -d '${INVOKE_EXAMPLE_BODY}'`,
        );
      }
      onListening?.(boundPort);
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE")
        failStartup(new Error(`port ${port} is already in use; choose another with --port`));
      failStartup(new Error(`cannot bind http channel on :${port}: ${error.message}`));
    },
  );
}

/**
 * Start a Cloudflare tunnel + announce/register webhooks once the server is bound — unless this is a
 * watch-supervisor worker, where the supervisor owns the long-lived tunnel so the public URL survives
 * reloads.
 */
export function maybeTunnel(workspaceDir: string, boundPort: number, tunnel: boolean): void {
  if (!tunnel || process.env.FASTAGENT_DEV_WORKER === "1") return;
  void startCloudflareTunnel(boundPort).then((t) => {
    if (!t) return;
    void announceWebhooks(workspaceDir, t.url, { openUrl: openExternalUrl });
    // Single-process (start / --no-watch): close the tunnel on exit (watch mode's supervisor owns its own).
    const cleanup = (): never => {
      t.close();
      process.exit(0);
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}

/**
 * Load and start the workspace's `schedules/` — a time-trigger firing the agent on each cron. Starts iff
 * there are static schedules OR `selfSchedule` is on (the scheduler also polls the agent's self-scheduled
 * wake-ups, which the built-in `wake` tool creates only when opted in). Shares the SAME (trace-wrapped)
 * agent the routes serve, so a scheduled turn is observed like any other. Best-effort stop on exit; dev's
 * watch restart re-reads schedules with the worker (schedules are a code input). Single-process.
 */
export async function startSchedules(
  workspaceDir: string,
  agent: Agent,
  stateRoot: string,
  selfSchedule: boolean,
): Promise<void> {
  const { schedules, failures } = await loadSchedules(workspaceDir).catch(failStartup);
  reportModuleLoadFailures(failures);
  // Nothing to run when there are neither static `schedules/` nor self-scheduling (the `wake` tool, and
  // thus any wake-up to poll, is mounted only when config.selfSchedule is on) — skip the poller entirely.
  if (schedules.length === 0 && !selfSchedule) return;
  const scheduler = createScheduler({ agent, stateRoot, schedules });
  scheduler.start();
  if (schedules.length > 0) log.info(`[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}`);
  const stop = (): void => scheduler.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
