/**
 * The serving spine shared by `dev` (its worker) and `start`: channel assembly, Node HTTP binding,
 * long-connection lifecycle, scheduler lifecycle, and the optional Cloudflare quick tunnel.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../agent.ts";
import { createStateSync } from "../channels/agentcore-state.ts";
import { agentcoreRoutes, UnknownScheduleError } from "../channels/agentcore.ts";
import { activeWork } from "../channels/busy.ts";
import { controlRoutes } from "../channels/control.ts";
import { INVOKE_EXAMPLE_BODY, createInvokeHandler } from "../channels/http.ts";
import { text } from "../channels/respond.ts";
import { type LoadedLongConnectionChannel, loadChannels } from "../engines/pi/channel.ts";
import { reportModuleLoadFailures } from "../engines/pi/report.ts";
import { answersLocalhost, bindLabel, classifyBind, clientHost } from "../bind.ts";
import { type Routes, parseRouteKey, router, serveNode } from "../host/node.ts";
import { log } from "../log.ts";
import { openExternalUrl } from "../open-url.ts";
import { loadSchedules } from "../schedule/discover.ts";
import type { LoadedSchedule } from "../schedule/schedule.ts";
import { createScheduler, fireScheduleOnce } from "../schedule/scheduler.ts";
import type { SessionControl } from "../session.ts";
import { announceWebhooks, startCloudflareTunnel } from "../tunnel.ts";
import { failStartup, failUsage } from "./fail.ts";

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
export async function routesFor(
  agentDir: string,
  agent: Agent,
  stateRoot: string,
  control?: SessionControl,
  options: { builtinInvoke?: boolean } = {},
): Promise<ServingSurface> {
  const { routes, longConnections, routeChannels, collisions, failures } = await loadChannels(agentDir, {
    agent,
    stateRoot,
    control,
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
  const builtinInvoke =
    options.builtinInvoke !== false && Object.keys(routes).length === 0 && longConnections.length === 0;
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
 * Mount the session control plane (`/control/*`) when the agent enabled it
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
  options: { tunnel?: boolean; agent?: Agent; host?: string } = {},
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
      writeFileSync(tmp, `${JSON.stringify({ url: `http://${clientHost(options.host)}:${boundPort}`, token })}\n`, {
        mode: 0o600,
      });
      chmodSync(tmp, 0o600); // an existing file keeps its old mode on rewrite — pin it
      renameSync(tmp, path);
      log.info(`[fastagent] session control on /control/* (token in ${path})`);
      // The serve binds ALL interfaces by DEFAULT (containers require it), so /control/* is
      // LAN-reachable with the bearer token as the only protection — the tunnel and deploy paths warn
      // loudly, and the LAN path must not be the silent third way past the local trust story. A
      // loopback bind closes exactly that reach, so it earns silence.
      const bind = classifyBind(options.host);
      if (bind !== "loopback") {
        log.warn(
          `[fastagent] the port binds ${bind === "wildcard" ? "all interfaces" : `${options.host} (off this machine)`}: ` +
            "/control/* is reachable on your LAN, protected only by the bearer token — bind loopback " +
            "(--bind 127.0.0.1), firewall the port, or wrap it for real exposure (docs: design §14)",
        );
      }
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
 * Mount the AgentCore Runtime adapter (`POST /invocations` + `GET /ping`) over the serving routes —
 * the deployed container's ONLY reachable surface (channels/agentcore.ts). Wired by `start` when
 * `FASTAGENT_AGENTCORE=1` (set by the generated deploy artifacts, never by hand). A channel colliding
 * on either path fails startup, same disposition as the control-plane mount: the adapter's paths are
 * the platform's contract, so a channel shadowing them would silently unserve the whole deployment.
 */
export function mountAgentcore(
  routes: Routes,
  options: { agent: Agent; stateRoot: string; schedules: LoadedSchedule[]; onStateReady?: () => void },
): Routes {
  const { agent, stateRoot, schedules, onStateReady } = options;
  const mounted = agentcoreRoutes({
    routes,
    agent,
    stateRoot,
    isBusy: () => activeWork() > 0,
    // Cross-deploy durability: AgentCore wipes the state mount on every runtime version update, so
    // the state root is restored from (and pushed to) an S3 snapshot through presigned URLs the
    // forwarder mints per envelope. Always wired on this path — the platform gives no other way to
    // keep an agent's memory across a deploy.
    stateSync: createStateSync({ stateRoot }),
    // What separates a forwarder envelope from any IAM principal's InvokeAgentRuntime call. Absent =
    // no forwarder in this topology, so only the public `invoke` kind is servable.
    ingressSecret: process.env.FASTAGENT_INGRESS_SECRET,
    onStateReady,
    fire:
      schedules.length === 0
        ? undefined
        : (name, slot) => {
            const schedule = schedules.find((s) => s.name === name);
            if (!schedule) throw new UnknownScheduleError(name);
            return fireScheduleOnce({ agent, stateRoot, schedule, slot });
          },
  });
  const mountedPaths = new Set(Object.keys(mounted).map((key) => parseRouteKey(key).path));
  const collisions = Object.keys(routes).filter((key) => mountedPaths.has(parseRouteKey(key).path));
  if (collisions.length > 0) {
    throw new Error(
      `channel route(s) ${collisions.map((key) => `"${key}"`).join(", ")} collide with the AgentCore adapter ` +
        `(/invocations, /ping) — rename the channel route`,
    );
  }
  return { ...routes, ...mounted };
}

/**
 * Refuse `--tunnel` with a bind that cloudflared cannot reach: it dials the NAME `localhost:<port>`
 * (the dev supervisor's tunnel too), so anything outside `127.0.0.1`/`::1`/wildcard — including a
 * `127.0.0.2` bind, loopback though it is — would leave the tunnel up and 502ing every request.
 * Checked BEFORE the bind (the flag alone pre-spawn in `dev`, again once config is loaded, since
 * `http.host` can carry the address), so the failure is clean rather than a live-but-broken public URL.
 * `source` decides the exit code, per fail.ts: a flag COMBINATION is a usage error (2), a value that
 * came from config is broken runtime configuration (1).
 */
export function assertTunnelBindable(host: string | undefined, tunnel: boolean, source: "flag" | "config"): void {
  if (!tunnel || answersLocalhost(host)) return;
  // Name the source, not just the exit code: under `config` there is no `--bind` to change and no flag
  // to drop, so flag-only wording would send the reader looking for something they never typed.
  const fix =
    source === "flag"
      ? "bind 0.0.0.0 (or 127.0.0.1), or drop --tunnel"
      : "set http.host to 0.0.0.0 (or 127.0.0.1) in fastagent.config.*, override it with --bind, or drop --tunnel";
  const message = `--tunnel reaches the serve by dialing localhost, which the bind address ${host} does not answer — ${fix}`;
  if (source === "flag") failUsage(message);
  failStartup(new Error(message));
}

/**
 * The startup lines that name WHERE the serve is: the bind report, and the curl the reader copies.
 * ONE function because they are one message — they were two, and `--bind` updated the first while the
 * second went on dialing `localhost`, which is precisely what a non-wildcard bind stops answering. Now
 * neither can be changed without the other in view, and the address has a single derivation.
 *
 * A wildcard bind is every interface, and naming one address there would understate it — but the curl
 * still needs one to dial, which is what `clientHost` gives (loopback for a wildcard, itself otherwise).
 */
export function readyAddressLines(host: string | undefined, boundPort: number, builtinInvoke: boolean): string[] {
  const dial = `${clientHost(host)}:${boundPort}`;
  const lines = [
    `[fastagent] http host on ${classifyBind(host) === "wildcard" ? `:${boundPort} (all interfaces)` : bindLabel(host, boundPort)}`,
  ];
  if (builtinInvoke) {
    lines.push(
      `[fastagent] try it: curl -s ${dial}/invoke -X POST -H 'content-type: application/json' -d '${INVOKE_EXAMPLE_BODY}'`,
    );
  }
  return lines;
}

/**
 * Bind HTTP, open long-connection channels, and report ready only when both forms are usable. Each
 * adapter owns reconnects; a terminal close rejects `closed` and fails the process visibly. Abort is
 * the sole clean-shutdown command. `host` unset binds all interfaces.
 */
export function serve(
  surface: ServingSurface,
  bind: { port: number; host?: string },
  onListening?: (boundPort: number) => void,
): void {
  const { port, host } = bind;
  const hosted = serveNode(router(surface.routes), { port, host });
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
        for (const line of readyAddressLines(host, boundPort, surface.builtinInvoke)) log.info(line);
        log.info(`[fastagent] routes: ${Object.keys(surface.routes).join(", ") || "(none)"}`);
        if (surface.longConnections.length > 0) {
          log.info(
            `[fastagent] long connections: ${surface.longConnections.map((connection) => connection.name).join(", ")}`,
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
      if (error.code === "EADDRINUSE") {
        // With a bind address the port is only taken ON THAT interface, so moving the bind is as valid
        // a fix as moving the port.
        failStartup(
          new Error(
            `${bindLabel(host, port)} is already in use; choose another with ` +
              `--port${classifyBind(host) === "wildcard" ? "" : " or --bind"}`,
          ),
        );
      }
      // Through `bindLabel`, like every other message about a bind: hand-concatenating gives `:::8787`
      // for an IPv6 bind and a bare `:8787` for the wildcard, which reads as an explicit bind of nothing.
      failStartup(new Error(`cannot bind http channel on ${bindLabel(host, port)}: ${error.message}`));
    },
  );
}

/** Start a Cloudflare tunnel for route channels only. */
export function maybeTunnel(
  agentDir: string,
  routeChannels: string[],
  boundPort: number,
  tunnel: boolean,
  stateRoot?: string,
): void {
  if (!tunnel || process.env.FASTAGENT_DEV_WORKER === "1") return;
  void startCloudflareTunnel(boundPort).then((instance) => {
    if (!instance) return;
    void announceWebhooks(agentDir, instance.url, { openUrl: openExternalUrl, routeChannels, stateRoot });
    const cleanup = (): void => instance.close();
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}

/**
 * Load and start the agent's `schedules/` — a time-trigger firing the agent on each cron. Starts iff
 * there are static schedules OR `selfSchedule` is on. Best-effort stop on process signals. Returns the
 * loaded schedules so a serving surface that needs them (the AgentCore adapter's fire binding) shares
 * ONE load instead of re-discovering. `externalClock` (AgentCore) arms no resident cron timers.
 */
export async function startSchedules(
  agentDir: string,
  agent: Agent,
  stateRoot: string,
  selfSchedule: boolean,
  options: { externalClock?: boolean } = {},
): Promise<LoadedSchedule[]> {
  const { schedules, failures } = await loadSchedules(agentDir).catch(failStartup);
  reportModuleLoadFailures(failures);
  if (schedules.length === 0 && !selfSchedule) return schedules;
  const scheduler = createScheduler({ agent, stateRoot, schedules, externalClock: options.externalClock });
  scheduler.start();
  if (schedules.length > 0) {
    log.info(
      `[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}${options.externalClock ? " (external clock — no resident cron timers)" : ""}`,
    );
  }
  const stop = (): void => scheduler.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return schedules;
}
