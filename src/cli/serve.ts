/** What `dev` (its worker) and `start` need beyond the service itself. */
import { answersLocalhost, bindLabel, classifyBind } from "../bind.ts";
import type { ChannelHandler } from "../channel.ts";
import type { AgentService, MountAgentServiceOptions } from "../service.ts";
import { serveNode } from "../channels/serve.ts";
import { log } from "../log.ts";
import { openExternalUrl } from "../open-url.ts";
import { declaredChannels } from "../channels/discover.ts";
import { announceWebhooks, startCloudflareTunnel } from "../tunnel.ts";
import { failStartup, failUsage } from "./fail.ts";

/** Refuse `--tunnel` with a `--bind` that cloudflared cannot reach. */
export function assertTunnelBindable(host: string | undefined, tunnel: boolean): void {
  if (!tunnel || answersLocalhost(host)) return;
  failUsage(
    `--tunnel reaches the serve by dialing localhost, which the bind address ${host} does not answer — bind 0.0.0.0 (or 127.0.0.1), or drop --tunnel`,
  );
}

/** What the CLI adds to the assembly: its shutdown grace, and exit on a connection that drops. */
export function cliMountOptions(): MountAgentServiceOptions {
  return {
    closeTimeoutMs: SHUTDOWN_GRACE_MS,
    onChannelClosed: (name, error) =>
      failStartup(new Error(`${name} ${error === undefined ? "closed unexpectedly" : `failed: ${String(error)}`}`)),
  };
}

/**
 * Bind, report, warn about reach, open the tunnel, and close in order on a signal — the tail dev's worker and start
 * share once the service is assembled.
 */
export function serveService(
  service: AgentService,
  bind: { port: number; host?: string },
  posture: { tunnel: boolean; agentDir: string; stateRoot: string },
): void {
  const { host } = bind;
  const { tunnel, agentDir, stateRoot } = posture;
  serve(service.handler, bind, {
    ready: service.ready,
    onListening: (p) => {
      reportServing(service, host, p);
      maybeTunnel(agentDir, service.channels.routes, p, tunnel, stateRoot);
    },
    onShutdown: () => service.close(),
  });
}

/** The "we are serving" report: the supervisor message `dev`'s watcher waits for, the addresses, and what mounted. */
export function reportServing(service: AgentService, host: string | undefined, boundPort: number): void {
  process.send?.({ type: "ready", port: boundPort, routeChannels: service.channels.routes });
  log.info(bindLine(host, boundPort));
  log.info(`[fastagent] routes: ${Object.keys(service.routes).join(", ") || "(none)"}`);
  if (service.channels.longConnections.length > 0) {
    log.info(`[fastagent] long connections: ${service.channels.longConnections.join(", ")}`);
  }
}

/** The line that names WHERE the serve is — every posture reports it, including AgentCore's own surface. */
export function bindLine(host: string | undefined, boundPort: number): string {
  return `[fastagent] http host on ${classifyBind(host) === "wildcard" ? `:${boundPort} (all interfaces)` : bindLabel(host, boundPort)}`;
}

/** What the CLI gives a service to stop in, and the hard exit that follows it. */
const SHUTDOWN_GRACE_MS = 800;
const FORCED_EXIT_MS = 1_500;

/** Bind HTTP and report ready — but only once the SERVICE is, which is not the same moment. */
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
    // Bounded: shutdown must not hang on a channel that will not close, so the deadline fires regardless.
    const deadline = setTimeout(() => {
      log.error(`[fastagent] shutdown did not finish within ${FORCED_EXIT_MS}ms; exiting`);
      process.exit(1);
    }, FORCED_EXIT_MS);
    // Stop accepting FIRST, before anything is awaited.
    const closingServer = hosted.close();
    hosted.closeAllConnections();
    // A cleanup that failed is not a clean exit.
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
        // A bound socket is NOT a serving agent: a declared socket-mode channel still has to come up, and reporting
        // ready before it does tells the supervisor (and --tunnel, and the operator) that a surface is live while a
        // channel is dead.
        await hooks.ready;
        if (stopping) return;
        hooks.onListening?.(boundPort);
      } catch (error) {
        failStartup(error);
      }
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        // With a bind address the port is only taken ON THAT interface, so moving the bind is as valid a fix as
        // moving the port.
        failStartup(
          new Error(
            `${bindLabel(host, port)} is already in use; choose another with ` +
              `--port${classifyBind(host) === "wildcard" ? "" : " or --bind"}`,
          ),
        );
      }
      // Through `bindLabel`, like every other message about a bind.
      failStartup(new Error(`cannot bind http channel on ${bindLabel(host, port)}: ${error.message}`));
    },
  );
}

/** Start a Cloudflare tunnel for route channels only. */
function maybeTunnel(
  agentDir: string,
  routeChannels: string[],
  boundPort: number,
  tunnel: boolean,
  stateRoot?: string,
): void {
  if (!tunnel || process.env.FASTAGENT_DEV_WORKER === "1") return;
  void startCloudflareTunnel(boundPort).then((instance) => {
    if (!instance) return;
    void announceWebhooks(agentDir, instance.url, declaredChannels(routeChannels), {
      openUrl: openExternalUrl,
      stateRoot,
    });
    const cleanup = (): void => instance.close();
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}
