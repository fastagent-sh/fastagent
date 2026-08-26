/**
 * The serving spine shared by `dev` (its worker) and `start`: channel assembly, Node HTTP binding,
 * long-connection lifecycle, scheduler lifecycle, and the optional Cloudflare quick tunnel.
 */
import {} from "node:path";
import type { Agent } from "../agent.ts";
import { createStateSync } from "../channels/agentcore-state.ts";
import { type RouteSurface, agentcoreRoutes, UnknownScheduleError } from "../channels/agentcore.ts";
import { activeWork } from "../channels/busy.ts";
import {} from "../channels/control.ts";
import { INVOKE_EXAMPLE_BODY } from "../channels/http.ts";
import {} from "../channels/respond.ts";
import {} from "../engines/pi/report.ts";
import { answersLocalhost, bindLabel, classifyBind, clientHost } from "../bind.ts";
import type { ChannelHandler, Routes } from "../channel.ts";
import type { AgentService } from "../service.ts";
import { routeKeysConflict, serveNode } from "../channels/serve.ts";
import { log } from "../log.ts";
import { openExternalUrl } from "../open-url.ts";
import {} from "../schedule/discover.ts";
import type { LoadedSchedule } from "../schedule/schedule.ts";
import { fireScheduleOnce } from "../schedule/scheduler.ts";
import { announceWebhooks, startCloudflareTunnel } from "../tunnel.ts";
import { failStartup, failUsage } from "./fail.ts";

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

/**
 * Mount the AgentCore Runtime adapter (`POST /invocations` + `GET /ping`) over the serving routes —
 * the deployed container's ONLY reachable surface (channels/agentcore.ts). Wired by `start` when
 * `FASTAGENT_AGENTCORE=1` (set by the generated deploy artifacts, never by hand). A channel colliding
 * on either path fails startup, same disposition as the control-plane mount: the adapter's paths are
 * the platform's contract, so a channel shadowing them would silently unserve the whole deployment.
 */
export function mountAgentcore(
  routes: Routes,
  options: {
    agent: Agent;
    stateRoot: string;
    schedules: readonly LoadedSchedule[];
    onStateReady?: () => void;
    /** The serving path's LAZY channel surface: constructed by the adapter on the first envelope
     *  AFTER the state-snapshot restore, never at boot (channels/agentcore.ts). When absent,
     *  `routes` is the dispatch target — for wirings whose state root is already authoritative. */
    lazyChannels?: () => Promise<RouteSurface>;
  },
): Routes {
  const { agent, stateRoot, schedules, onStateReady, lazyChannels } = options;
  const mounted = agentcoreRoutes({
    routes: lazyChannels ?? { routes },
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
  const collisions = Object.keys(routes).filter((key) =>
    Object.keys(mounted).some((adapterKey) => routeKeysConflict(key, adapterKey)),
  );
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
/**
 * The "we are serving" report: the supervisor message `dev`'s watcher waits for, the addresses, and
 * what mounted. One function because both commands must say the same thing at the same moment —
 * after readiness, never at socket bind.
 */
export function reportServing(service: AgentService, host: string | undefined, boundPort: number): void {
  process.send?.({ type: "ready", port: boundPort, routeChannels: service.channels.routes });
  for (const line of readyAddressLines(host, boundPort, service.channels.builtinInvoke)) log.info(line);
  log.info(`[fastagent] routes: ${Object.keys(service.routes).join(", ") || "(none)"}`);
  if (service.channels.longConnections.length > 0) {
    log.info(`[fastagent] long connections: ${service.channels.longConnections.join(", ")}`);
  }
}

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
/** What the CLI gives a service to stop in, and the hard exit that follows it. The order matters:
 *  a forced exit before the service answers would report a clean shutdown over a stuck channel. */
export const SHUTDOWN_GRACE_MS = 800;
const FORCED_EXIT_MS = 1_500;

export function serve(
  handler: ChannelHandler,
  bind: { port: number; host?: string },
  hooks: {
    /** Awaited before anything is reported ready — see the listening handler. */
    ready?: Promise<void>;
    onListening?: (boundPort: number) => void;
    onShutdown?: () => Promise<void> | void;
  } = {},
): void {
  const { port, host } = bind;
  const hosted = serveNode(handler, { port, host });
  let stopping = false;
  const stop = (exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    // Bounded: shutdown must not hang on a channel that will not close, so the deadline fires
    // regardless. No drain — an in-flight turn is cut, which is the existing contract.
    // Later than the service's own close deadline (SHUTDOWN_GRACE_MS below), or the process leaves
    // at 0 before `close()` has said a channel would not stop.
    const deadline = setTimeout(() => {
      log.error(`[fastagent] shutdown did not finish within ${FORCED_EXIT_MS}ms; exiting`);
      process.exit(1);
    }, FORCED_EXIT_MS);
    // Stop accepting FIRST, before anything is awaited. `onShutdown` waits for long connections to
    // close, and a socket still listening through that wait would dispatch new work into channels
    // and a scheduler that are already shutting down.
    const closingServer = hosted.close();
    hosted.closeAllConnections();
    // A cleanup that failed is not a clean exit: `close()` reports a channel that would not stop,
    // and swallowing it here would end the process at 0 over a resource still holding on.
    void Promise.allSettled([closingServer, Promise.resolve(hooks.onShutdown?.())]).then((outcomes) => {
      let code = exitCode;
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          log.error(`[fastagent] shutdown failed: ${String(outcome.reason)}`);
          code = 1;
        }
      }
      clearTimeout(deadline);
      process.exit(code);
    });
  };
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  hosted.listening.then(
    async (boundPort) => {
      try {
        // A bound socket is NOT a serving agent: a declared socket-mode channel still has to come
        // up, and reporting ready before it does tells the supervisor (and --tunnel, and the
        // operator) that a surface is live while a channel is dead.
        await hooks.ready;
        if (stopping) return;
        hooks.onListening?.(boundPort);
      } catch (error) {
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
