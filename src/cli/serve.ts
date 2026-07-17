/**
 * The serving spine shared by `dev` (its worker) and `start`: route assembly from discovered
 * channels/, the Node host binding, the scheduler lifecycle, and the optional Cloudflare quick
 * tunnel. Bodies moved verbatim from cli.ts; `values.tunnel` became a parameter.
 */
import type { Agent } from "../agent.ts";
import { createInvokeHandler } from "../channels/http.ts";
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
 */
export async function routesFor(workspaceDir: string, agent: Agent, stateRoot: string): Promise<Routes> {
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
  const channels = Object.keys(routes).length > 0 ? routes : { "POST /invoke": createInvokeHandler(agent) };
  // Add a default GET /health unless a channel already covers it (overlap, not exact-key: an
  // any-method `/health` also handles GET, so the built-in steps aside).
  const healthCovered = Object.keys(channels).some((k) => {
    const e = parseRouteKey(k);
    return e.path === "/health" && (e.method === undefined || e.method === "GET");
  });
  return healthCovered ? channels : { "GET /health": () => text("ok\n", 200), ...channels };
}

/** Serve `routes` via the Node host. serveNode owns binding; the CLI owns policy (errors, ready signal, log). */
export function serve(routes: Routes, port: number, onListening?: (boundPort: number) => void): void {
  serveNode(router(routes), { port }).listening.then(
    (boundPort) => {
      process.send?.({ type: "ready", port: boundPort }); // tell the dev supervisor we bound + on which port
      log.info(`[fastagent] http channel on :${boundPort}`);
      log.info(`[fastagent] routes: ${Object.keys(routes).join(", ") || "(none)"}`);
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
