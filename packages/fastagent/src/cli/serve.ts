/** What `dev` (its worker) and `start` need beyond the service itself. */
import { bindLabel, classifyBind } from "../bind.ts";
import type { ServedAgent, ServeOptions, Service } from "../service.ts";
import { API_PREFIX } from "@fastagent-sh/client/http/contract";
import { API_KEY_VARIABLE, apiKeysFrom } from "../http/server.ts";
import { log } from "../log.ts";
import { failStartup } from "./fail.ts";
import { announceOwner } from "./owner.ts";

/** What the CLI adds to the assembly: the API's keys. */
export function cliMountOptions(): ServeOptions {
  return { apiKeys: apiKeysFrom(process.env[API_KEY_VARIABLE]) };
}

/**
 * Bind, report, warn about reach, and close in order on a signal — the tail dev's worker and start share once the
 * service is assembled. With `owner`, the serve says it owns the instance (owner.ts) once it listens, holding the
 * key it serves this machine's commands with, and unsays it first when it stops.
 */
export function serveService(
  service: ServedAgent,
  bind: { port: number; host?: string },
  owner?: { stateRoot: string; key: string },
): void {
  let unannounce = () => {};
  const announced: Service = {
    ...service,
    close: () => {
      unannounce();
      return service.close();
    },
  };
  serve(announced, bind, (port) => {
    if (owner !== undefined) unannounce = announceOwner(owner.stateRoot, bind.host, port, owner.key);
    reportServing(service, bind.host, port, owner !== undefined);
  });
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

/** Listen, and report ready once bound, until a signal closes it. */
function serve(
  service: Service,
  bind: { port: number; host?: string },
  onListening?: (boundPort: number) => void,
): void {
  const { port, host } = bind;
  let stopping = false;
  const stop = (exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    // Bounded: shutdown must not hang on a step that will not finish, so the deadline fires regardless.
    const deadline = setTimeout(() => {
      log.error(`[fastagent] shutdown did not finish within ${FORCED_EXIT_MS}ms; exiting`);
      process.exit(1);
    }, FORCED_EXIT_MS);
    // A cleanup that failed is not a clean exit.
    void service.close().then(
      () => {
        clearTimeout(deadline);
        process.exit(exitCode);
      },
      (error: unknown) => {
        log.error(`[fastagent] shutdown failed: ${String(error)}`);
        clearTimeout(deadline);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  service.listen(port, host).then(
    (boundPort) => {
      if (!stopping) onListening?.(boundPort);
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
      failStartup(new Error(`cannot bind on ${bindLabel(host, port)}: ${error.message}`));
    },
  );
}
