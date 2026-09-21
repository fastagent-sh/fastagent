/** What `dev` (its worker) and `start` need beyond the service itself. */
import { INVOKE_EXAMPLE_BODY } from "../channels/http.ts";
import { answersLocalhost, bindAddress, bindLabel, classifyBind, clientHost } from "../bind.ts";
import type { Agent } from "../agent.ts";
import type { ChannelHandler } from "../channel.ts";
import type { AgentService, MountableAgent, MountAgentServiceOptions } from "../service.ts";
import { serveNode } from "../channels/serve.ts";
import { log } from "../log.ts";
import { openExternalUrl } from "../open-url.ts";
import { declaredChannels } from "../channels/discover.ts";
import { announceWebhooks, startCloudflareTunnel } from "../tunnel.ts";
import { failStartup, failUsage } from "./fail.ts";

/** Refuse `--tunnel` with a bind that cloudflared cannot reach. */
export function assertTunnelBindable(host: string | undefined, tunnel: boolean, source: "flag" | "config"): void {
  if (!tunnel || answersLocalhost(host)) return;
  // Name the source, not just the exit code: under `config` there is no `--bind` to change and no flag to drop, so
  // flag-only wording would send the reader looking for something they never typed.
  const fix =
    source === "flag"
      ? "bind 0.0.0.0 (or 127.0.0.1), or drop --tunnel"
      : "set http.host to 0.0.0.0 (or 127.0.0.1) in fastagent.config.ts, override it with --bind, or drop --tunnel";
  const message = `--tunnel reaches the serve by dialing localhost, which the bind address ${host} does not answer — ${fix}`;
  if (source === "flag") failUsage(message);
  failStartup(new Error(message));
}

/**
 * The bind address a serve uses: the flag, else `http.host` from the config, else the caller's `fallback` (omitted =
 * the wildcard). Only that last rung differs between the commands; why each ends where it does lives with the
 * command — `devBindHost` in commands/dev.ts, the wildcard `start` needs for a container in commands/start.ts.
 */
export function resolveBindHost(
  bindFlag: string | undefined,
  configured: string | undefined,
  tunnel: boolean,
  fallback?: string,
): string | undefined {
  const host = bindFlag ?? (configured === undefined ? fallback : bindAddress(configured));
  assertTunnelBindable(host, tunnel, bindFlag ? "flag" : "config");
  return host;
}

/**
 * Apply the flags that override what the definition said, for THIS run only.
 *
 * ONE place, because `dev` and `start` both do it and a mapping two call sites must each remember is one a third
 * will not.
 *
 * `--no-invoke` outranks `http.invoke`, for the same reason `--bind` outranks `http.host`: a config value travels
 * into a deployed image, so "do not publish a turn endpoint on this tunnel" has to be sayable without editing the
 * definition.
 *
 * It takes `POST /run` WITH it, including over a definition that said `http.run: true`. Both routes start a
 * turn for an anonymous caller, and the flag's whole reason for existing is the case where the definition cannot be
 * edited — `dev --tunnel --no-invoke` leaving the other one published at the tunnel URL would be the flag failing at
 * exactly the job it was added for.
 */
export function withRunOverrides<T extends MountableAgent>(opened: T, run: { invoke?: boolean }): T {
  return run.invoke === false ? { ...opened, serveInvoke: false, serveRun: false } : opened;
}

/** What the CLI adds to the assembly: its shutdown grace, and exit on a connection that drops. */
export function cliMountOptions(wrapAgent: (agent: Agent) => Agent): MountAgentServiceOptions {
  return {
    wrapAgent,
    closeTimeoutMs: SHUTDOWN_GRACE_MS,
    onChannelClosed: (name, error) =>
      failStartup(new Error(`${name} ${error === undefined ? "closed unexpectedly" : `failed: ${String(error)}`}`)),
  };
}

/**
 * Bind, report, announce the control plane, open the tunnel, and close in order on a signal — the tail dev's worker
 * and start share once the service is assembled.
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
      announceControl(service, { host, tunnel });
      maybeTunnel(agentDir, service.channels.routes, p, tunnel, stateRoot);
    },
    onShutdown: () => service.close(),
  });
}

/** The "we are serving" report: the supervisor message `dev`'s watcher waits for, the addresses, and what mounted. */
export function reportServing(service: AgentService, host: string | undefined, boundPort: number): void {
  process.send?.({ type: "ready", port: boundPort, routeChannels: service.channels.routes });
  for (const line of readyAddressLines(host, boundPort, service.unverifiedRoutes.includes("POST /invoke"))) {
    log.info(line);
  }
  log.info(`[fastagent] routes: ${Object.keys(service.routes).join(", ") || "(none)"}`);
  if (service.channels.longConnections.length > 0) {
    log.info(`[fastagent] long connections: ${service.channels.longConnections.join(", ")}`);
  }
}

/** The line that names WHERE the serve is — every posture reports it, including AgentCore's own surface. */
export function bindLine(host: string | undefined, boundPort: number): string {
  return `[fastagent] http host on ${classifyBind(host) === "wildcard" ? `:${boundPort} (all interfaces)` : bindLabel(host, boundPort)}`;
}

/**
 * The startup lines for a serve of OUR surface: the bind report, and the curl the reader copies.
 *
 * `servesInvoke` is `AgentService.unverifiedRoutes`, never a guess from the route table: `http.invoke: false` leaves no
 * `/invoke` to curl, and a channel may serve that path with a protocol of its own — both would turn this line into
 * a copyable request that fails.
 */
export function readyAddressLines(host: string | undefined, boundPort: number, servesInvoke: boolean): string[] {
  const dial = `${clientHost(host)}:${boundPort}`;
  return [
    bindLine(host, boundPort),
    ...(servesInvoke
      ? [
          `[fastagent] try it: curl -s ${dial}/invoke -X POST -H 'content-type: application/json' -d '${INVOKE_EXAMPLE_BODY}'`,
        ]
      : []),
  ];
}

/**
 * Say what this port exposes and how far it reaches.
 *
 * NOTHING fastagent serves is authenticated — authentication belongs to the deployment (a gateway, a private
 * network, AgentCore's IAM, an embedder's middleware). Two of the three warnings fire at a REACH the operator did
 * not get by default: a bind off this machine, and `--tunnel`'s public URL.
 *
 * The cross-origin one is UNCONDITIONAL, including on a loopback `dev`, because the grant is. `*` is the default
 * (`channels/serve.ts`), so a page the developer merely visits can drive this port from their browser and read the
 * reply — and a loopback bind, which used to make that impossible, no longer does. Nobody opts into a default, so
 * the one posture the decision costs is the one that has to hear about it.
 *
 * WHAT IS EXPOSED is read off `AgentService.unverifiedRoutes`, never assumed and never guessed from the route table.
 * `POST /invoke` is on most serves but not all: AgentCore answers the Runtime's `/invocations` behind IAM,
 * `http.invoke: false` withholds it, and a channel may serve that path itself — in which case the caller it is
 * open to is the platform that signs its requests, not anyone at all. A warning naming an endpoint this process
 * does not serve is how an operator learns to skim past all of them — the same reason `preflightDeploy` takes
 * `publicUrl`.
 */
export function announceControl(
  service: Pick<AgentService, "controlPrefix" | "unverifiedRoutes" | "corsOrigins">,
  bind: { host?: string; tunnel: boolean },
): void {
  const { controlPrefix, corsOrigins } = service;
  if (controlPrefix) log.info(`[fastagent] session control on ${controlPrefix}/*`);
  // What an unauthenticated caller of this port can do, worst first. From `unverifiedRoutes`, so a channel that serves
  // `/invoke` itself is not described as our unauthenticated data plane — it has its own signature check.
  const exposed = [
    ...(service.unverifiedRoutes.includes("POST /invoke") ? ["POST /invoke (run a turn with this agent's tools)"] : []),
    ...(service.unverifiedRoutes.includes("POST /run")
      ? ["POST /run (run any routine this agent declares; GET /routines lists them)"]
      : []),
    ...(controlPrefix ? [`${controlPrefix}/* (read, steer, delete any session)`] : []),
  ];
  if (exposed.length === 0) return; // nothing of ours answers here (the AgentCore adapter's surface)
  const what = `${exposed.join(" and ")} ${exposed.length > 1 ? "answer" : "answers"}`;
  if (corsOrigins === undefined || corsOrigins.includes("*")) {
    log.warn(
      `[fastagent] any web page your browser visits can call this serve cross-origin and read the reply: ${what} ` +
        "with no credential. That is the default (`*`); pin the origins you actually use with http.cors " +
        "(docs/design/session-control.md §14)",
    );
  }
  const reach = classifyBind(bind.host);
  if (reach !== "loopback") {
    log.warn(
      `[fastagent] the port binds ${reach === "wildcard" ? "all interfaces" : `${bind.host} (off this machine)`}: ` +
        `${what} UNAUTHENTICATED to anyone who can reach it — bind loopback (--bind 127.0.0.1), ` +
        "firewall the port, or front it with a gateway (docs/design/session-control.md §14)",
    );
  }
  if (bind.tunnel) {
    log.warn(
      `[fastagent] --tunnel publishes this port at a public URL with NO authentication: ${what} to anyone with ` +
        "that URL — put real auth in front before sharing it (docs/design/session-control.md §14)",
    );
  }
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
