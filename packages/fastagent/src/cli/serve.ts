/** What `dev` (its worker) and `start` need beyond the service itself. */
import { bindAddress, bindLabel, classifyBind, isBindAddress } from "../bind.ts";
import type { ServedAgent, ServeOptions } from "../service.ts";
import { API_PREFIX } from "@fastagent-sh/client/http/contract";
import { API_KEY_VARIABLE, apiKeysFrom } from "../http/server.ts";
import { log } from "../log.ts";
import { failStartup, failUsage } from "./fail.ts";
import { announceOwner } from "./owner.ts";

/** Parse + range-check a port string (CLI flag or env). */
export function parsePort(value: string | undefined, source: string, from: "flag" | "env"): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed) || Number(trimmed) > 65535) {
    const message = `invalid ${source} "${value}": must be an integer 0-65535`;
    if (from === "flag") failUsage(message);
    failStartup(new Error(message));
  }
  return Number(trimmed);
}

/**
 * Parse a `--bind` address: empty/whitespace is "not set" → undefined (falls through to config, then all interfaces).
 */
export function parseBind(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!isBindAddress(trimmed)) failUsage(`invalid --bind "${value}": must be an IP address or "localhost"`);
  return bindAddress(trimmed);
}

/** What the CLI adds to the assembly: the API's keys. */
export function cliMountOptions(): ServeOptions {
  return { apiKeys: apiKeysFrom(process.env[API_KEY_VARIABLE]) };
}

interface ServeHooks {
  exit?: (code: number) => void;
  registerSignal?: (signal: NodeJS.Signals, handler: () => void) => () => void;
  onListening?: (port: number) => void;
  forcedExitMs?: number;
}

/**
 * Bind, report, warn about reach, and close in order on a signal or unexpected runtime shutdown — the tail dev's worker
 * and start share once the service is assembled. With `owner`, the serve says it owns the instance (owner.ts) once it
 * listens, holding the key it serves this machine's commands with, and unsays it first when it stops.
 */
export function serveService(
  service: ServedAgent,
  bind: { port: number; host?: string },
  owner?: { stateRoot: string; key: string },
  hooks?: ServeHooks,
): void {
  let unannounce = () => {};
  serve(
    service,
    bind,
    (port) => {
      if (owner !== undefined) unannounce = announceOwner(owner.stateRoot, bind.host, port, owner.key);
      reportServing(service, bind.host, port, owner !== undefined);
      hooks?.onListening?.(port);
    },
    () => unannounce(),
    hooks,
  );
}

/** The "we are serving" report: the supervisor message `dev`'s watcher waits for, the address, and the Agent API. */
function reportServing(service: ServedAgent, host: string | undefined, boundPort: number, owned: boolean): void {
  process.send?.({ type: "ready" });
  log.info(bindLine(host, boundPort));
  const keyed = apiKeysFrom(process.env[API_KEY_VARIABLE]).length > 0;
  log.info(
    keyed
      ? `[fastagent] Agent API: ${API_PREFIX} (keys from ${API_KEY_VARIABLE})`
      : owned && service.api
        ? `[fastagent] Agent API: ${API_PREFIX}, for this machine's fastagent commands — set ${API_KEY_VARIABLE} for other callers`
        : `[fastagent] Agent API: not served — set ${API_KEY_VARIABLE} to serve it under ${API_PREFIX}`,
  );
}

/** The line that names WHERE the serve is: every posture reports it. */
function bindLine(host: string | undefined, boundPort: number): string {
  return `[fastagent] http host on ${classifyBind(host) === "wildcard" ? `:${boundPort} (all interfaces)` : bindLabel(host, boundPort)}`;
}

/** The hard exit that follows the whole close, beyond the server's own grace for requests in flight (http/serve.ts). */
const FORCED_EXIT_MS = 1_500;

/** Listen, and report ready once bound, until a signal or unexpected runtime shutdown closes it. */
function serve(
  service: ServedAgent,
  bind: { port: number; host?: string },
  onListening?: (boundPort: number) => void,
  beforeClose?: () => void,
  hooks?: ServeHooks,
): void {
  const { port, host } = bind;
  const exit = hooks?.exit ?? ((code: number) => process.exit(code));
  const registerSignal =
    hooks?.registerSignal ??
    ((signal: NodeJS.Signals, handler: () => void) => {
      process.once(signal, handler);
      return () => process.off(signal, handler);
    });
  const forcedExitMs = hooks?.forcedExitMs ?? FORCED_EXIT_MS;
  let stopping = false;
  let unsubRuntime = () => {};
  let unsubSigint = () => {};
  let unsubSigterm = () => {};
  const cleanupListeners = (): void => {
    unsubRuntime();
    unsubSigint();
    unsubSigterm();
  };
  const stop = (exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    cleanupListeners();
    beforeClose?.();
    // Bounded: shutdown must not hang on a step that will not finish, so the deadline fires regardless.
    const deadline = setTimeout(() => {
      log.error(`[fastagent] shutdown did not finish within ${forcedExitMs}ms; exiting`);
      exit(1);
    }, forcedExitMs);
    // A cleanup that failed is not a clean exit.
    void service.close().then(
      () => {
        clearTimeout(deadline);
        exit(exitCode);
      },
      (error: unknown) => {
        log.error(`[fastagent] shutdown failed: ${String(error)}`);
        clearTimeout(deadline);
        exit(1);
      },
    );
  };
  unsubSigint = registerSignal("SIGINT", () => stop(0));
  unsubSigterm = registerSignal("SIGTERM", () => stop(0));
  if (!service.ready()) {
    log.error("[fastagent] agent runtime stopped unexpectedly; shutting down");
    stop(1);
    return;
  }
  unsubRuntime = service.onRuntimeClose(() => {
    if (stopping) return;
    // Defer out of pi-durable's synchronous subscribeClose callback (must not block or call Session APIs inside it).
    queueMicrotask(() => {
      if (stopping) return;
      log.error("[fastagent] agent runtime stopped unexpectedly; shutting down");
      stop(1);
    });
  });
  service.listen(port, host).then(
    (boundPort) => {
      if (!stopping) onListening?.(boundPort);
    },
    (error: NodeJS.ErrnoException) => {
      if (stopping) return;
      cleanupListeners();
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
      failStartup(new Error(`cannot bind on ${bindLabel(host, port)}: ${error.message}`));
    },
  );
}
