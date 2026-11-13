/**
 * Slack Socket Mode: how an app receives with no public URL. `apps.connections.open` (the app-level token) gives a
 * short-lived `wss://` address; Slack sends `hello`, then every event as an envelope that must be acknowledged by its
 * `envelope_id` within three seconds or Slack sends it again. Connections are refreshed every few hours: Slack says so
 * with a `disconnect` (a `warning` about ten seconds ahead, then `refresh_requested`), and the app opens the next
 * connection BEFORE the old one goes, so no event falls between them.
 *
 * What ends the connection and what does not follows what can be done about it. Before the first `hello`, any failure
 * ends it: a start that cannot reach Slack, or is refused, is the operator's to see. After it, a lost socket, a
 * refused `apps.connections.open` that can pass (rate limit, an outage) or a connection that stops answering pings is
 * retried with a growing wait; a refused token and Socket Mode turned off for the app (`link_disabled`) end it with their
 * reason, because retrying cannot fix them.
 */
import type { LongConnection } from "../../channel.ts";
import { RuntimeWebSocket, pinger, watchPongs } from "../../runtime-websocket.ts";
import { log } from "../../log.ts";
import { pause, whenAborted } from "../kit/ingress.ts";
import type { SlackEventEnvelope } from "./parse.ts";

const RETRY_FIRST_MS = 1_000;
const RETRY_CAP_MS = 30_000;
/** How long a new connection may take to say `hello`. */
const HELLO_MS = 15_000;
/** A socket that stays silent is asked, with a ping, whether it is there: how often, and how long to wait for the pong. */
const PING_EVERY_MS = 30_000;
const PONG_WITHIN_MS = 10_000;

/** What `apps.connections.open` says when the token is the problem: no retry will fix these. */
const TERMINAL_OPEN_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "not_allowed_token_type",
  "missing_scope",
  "no_permission",
]);

/** The socket as this module uses it, so a test can stand in a fake and a runtime without pings still serves. */
interface SlackSocket {
  send(data: string): void;
  close(): void;
  /** Sends a ping frame, when the runtime can; its pong arrives as `handlers.pong`. */
  ping?(): void;
}

export interface SlackSocketHandlers {
  message(data: string): void;
  pong(): void;
  /** The socket ended, or could not be opened; `reason` says how. */
  close(reason: string): void;
}

export type OpenSlackSocket = (url: string, handlers: SlackSocketHandlers) => SlackSocket;

export interface SlackSocketOptions {
  apiBaseUrl: string;
  /** The app-level token (`xapp-…`). */
  appToken: string;
  /** Take an `event_callback` durably; a rejection leaves its envelope unacknowledged, so Slack sends it again. */
  ingest(envelope: SlackEventEnvelope): Promise<void>;
  /** Replaces the WebSocket and the waits, for tests. */
  openSocket?: OpenSlackSocket;
  timing?: {
    retryFirstMs?: number;
    retryCapMs?: number;
    helloMs?: number;
    pingEveryMs?: number;
    pongWithinMs?: number;
  };
}

/** The runtime's own WebSocket, with the pings it can send; a runtime that offers none serves without them. */
const openRuntimeSocket: OpenSlackSocket = (url, handlers) => {
  const socket = new RuntimeWebSocket(url);
  const stopPongs = watchPongs(socket, () => handlers.pong());
  const ping = pinger(socket);
  let closed = false;
  const end = (reason: string): void => {
    if (closed) return;
    closed = true;
    stopPongs();
    handlers.close(reason);
  };
  socket.addEventListener("message", (event) => handlers.message(String(event.data)));
  socket.addEventListener("error", (event) =>
    end(`socket error${(event as ErrorEvent).message ? `: ${(event as ErrorEvent).message}` : ""}`),
  );
  socket.addEventListener("close", (event) => end(`closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`));
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    ...(ping ? { ping } : {}),
  };
};

/** A failure no retry can fix: the connection ends with it. */
export class TerminalSocketError extends Error {}

/**
 * `apps.connections.open`: the address a connection is dialled at. A refusal that names the token (see
 * {@link TERMINAL_OPEN_ERRORS}) is a {@link TerminalSocketError}; one that can pass (a rate limit, an outage) and an
 * unreachable Slack are plain errors.
 */
export async function openSlackConnection(apiBaseUrl: string, appToken: string, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}`, "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    });
  } catch (error) {
    throw new Error(`apps.connections.open could not be reached: ${String(error)}`, { cause: error });
  }
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
  if (body.ok === true && typeof body.url === "string") return body.url;
  const reason = body.error ?? `HTTP ${response.status}`;
  const message = `apps.connections.open failed: ${reason}`;
  throw TERMINAL_OPEN_ERRORS.has(reason) ? new TerminalSocketError(message) : new Error(message);
}

/** One open connection: what ended it is what its `ended` says. */
interface Connection {
  socket: SlackSocket;
  /** What Slack's `hello` said of this app: its id, and how many connections it has open (this one included). */
  hello: { appId?: string; connections?: number };
  /**
   * `refresh`: Slack said it is about to replace this one. `lost`: it is gone, or stopped answering. Rejects with the
   * reason when no retry can fix it.
   */
  ended: Promise<"refresh" | "lost">;
  close(): void;
}

/** Hold a Socket Mode connection until `signal` aborts; `ready` settles at the first `hello`. */
export function connectSlackSocket(options: SlackSocketOptions, signal: AbortSignal): LongConnection {
  const { apiBaseUrl, appToken, ingest } = options;
  const openSocket = options.openSocket ?? openRuntimeSocket;
  const retryFirstMs = options.timing?.retryFirstMs ?? RETRY_FIRST_MS;
  const retryCapMs = options.timing?.retryCapMs ?? RETRY_CAP_MS;
  const helloMs = options.timing?.helloMs ?? HELLO_MS;
  const pingEveryMs = options.timing?.pingEveryMs ?? PING_EVERY_MS;
  const pongWithinMs = options.timing?.pongWithinMs ?? PONG_WITHIN_MS;
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let isReady = false;
  const markReady = (): void => {
    if (isReady) return;
    isReady = true;
    ready.resolve();
  };

  const openUrl = (): Promise<string> => openSlackConnection(apiBaseUrl, appToken, signal);

  /** Acknowledge each event once it is taken; an event that cannot be taken is left for Slack to send again. */
  const handleEnvelope = async (socket: SlackSocket, envelope: Record<string, unknown>): Promise<void> => {
    const id = envelope.envelope_id;
    if (typeof id !== "string") return;
    if (envelope.type === "events_api") {
      const payload = envelope.payload as SlackEventEnvelope | undefined;
      if (payload?.type === "event_callback") {
        try {
          await ingest(payload);
        } catch (error) {
          log.error(
            `[slack] an event was not taken, so it is not acknowledged and Slack will send it again: ${String(error)}`,
          );
          return;
        }
      }
    } else {
      // Interactivity and slash commands are not what this channel serves: acknowledged, so Slack does not resend them.
      log.debug(`[slack] ignoring a Socket Mode "${String(envelope.type)}" envelope`);
    }
    try {
      socket.send(JSON.stringify({ envelope_id: id }));
    } catch (error) {
      // The connection went while the event was taken (a refresh closes the old one): Slack sends it again, and the
      // delivery ring in the channel recognises it.
      log.debug(`[slack] could not acknowledge an event on a closed connection: ${String(error)}`);
    }
  };

  /** Dial `url` and resolve at its `hello`; the connection then answers events until it ends. */
  const dial = (url: string): Promise<Connection> =>
    new Promise((resolve, reject) => {
      const ended = Promise.withResolvers<"refresh" | "lost">();
      let outcome: "refresh" | "lost" | undefined;
      let helloed = false;
      let pingTimer: NodeJS.Timeout | undefined;
      let pongTimer: NodeJS.Timeout | undefined;
      const stop = (): void => {
        clearTimeout(pingTimer);
        clearTimeout(pongTimer);
      };
      const finish = (value: "refresh" | "lost"): void => {
        if (outcome !== undefined) return;
        outcome = value;
        stop();
        ended.resolve(value);
      };
      const fail = (error: unknown): void => {
        stop();
        stopWatching();
        socket.close();
        if (!helloed) reject(error);
        else if (error instanceof TerminalSocketError) {
          // Only the connection still in service ends the channel with it: one already let go has nothing to tell.
          if (outcome === undefined) {
            outcome = "lost";
            ended.reject(error);
          }
        } else finish("lost");
      };
      const helloTimer = setTimeout(() => fail(new Error(`no hello from Slack within ${helloMs / 1000}s`)), helloMs);
      // Until it says hello, the connection is only a socket being opened: an abort ends it at once, and `run` reads
      // the rejection as the cancellation it is.
      const stopWatching = whenAborted(signal, () => {
        clearTimeout(helloTimer);
        fail(new Error("cancelled"));
      });
      const ping = (): void => {
        if (socket.ping === undefined) return;
        pingTimer = setTimeout(() => {
          socket.ping?.();
          pongTimer = setTimeout(() => {
            log.warn(`[slack] Socket Mode connection stopped answering pings; reconnecting`);
            fail(new Error("no pong"));
          }, pongWithinMs);
        }, pingEveryMs);
      };
      const socket = openSocket(url, {
        message: (data) => {
          let envelope: Record<string, unknown>;
          try {
            envelope = JSON.parse(data) as Record<string, unknown>;
          } catch {
            log.warn("[slack] ignoring a Socket Mode message that is not JSON");
            return;
          }
          if (envelope.type === "hello") {
            clearTimeout(helloTimer);
            stopWatching();
            helloed = true;
            ping();
            const info = envelope.connection_info as { app_id?: unknown } | undefined;
            resolve({
              socket,
              hello: {
                ...(typeof info?.app_id === "string" ? { appId: info.app_id } : {}),
                ...(typeof envelope.num_connections === "number" ? { connections: envelope.num_connections } : {}),
              },
              ended: ended.promise,
              close: () => {
                finish("lost");
                socket.close();
              },
            });
          } else if (envelope.type === "disconnect") {
            const reason = String(envelope.reason);
            if (reason === "link_disabled") {
              fail(new TerminalSocketError("Slack Socket Mode is turned off for this app (link_disabled)"));
            } else if (reason === "warning" || reason === "refresh_requested") {
              finish("refresh");
            } else {
              log.warn(`[slack] Slack asked this Socket Mode connection to go (${reason})`);
              finish("lost");
            }
          } else {
            void handleEnvelope(socket, envelope);
          }
        },
        pong: () => {
          clearTimeout(pongTimer);
          clearTimeout(pingTimer);
          ping();
        },
        close: (reason) => {
          clearTimeout(helloTimer);
          stopWatching();
          fail(new Error(`Socket Mode connection ${reason}`));
        },
      });
    });

  /**
   * Slack answers `apps.connections.open` and says `hello` whether or not Socket Mode is on for the app, and sends
   * events only while it is, so a connection that is "ready" can be deaf with nothing to say so. The first `hello` is
   * where to say which app this is and what it depends on. Slack also splits an app's events among its connections, so
   * another one open at the start (another process, another developer) takes some of them.
   */
  const announce = ({ appId, connections }: Connection["hello"]): void => {
    log.info(
      `[slack] Socket Mode connected${appId ? ` to app ${appId}` : ""}; events arrive only while Socket Mode is on in ` +
        "the app's settings",
    );
    if (connections !== undefined && connections > 1) {
      log.warn(
        `[slack] ${connections} connections are open for this app, and Slack splits its events between them: ` +
          "another process uses the same app-level token, so this one will miss some messages",
      );
    }
  };

  const run = async (): Promise<void> => {
    let current: Connection | undefined;
    let waitMs = retryFirstMs;
    try {
      while (!signal.aborted) {
        let next: Connection;
        try {
          next = await dial(await openUrl());
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof TerminalSocketError || !isReady) throw error;
          log.warn(`[slack] Socket Mode connection failed, retrying in ${waitMs / 1000}s: ${String(error)}`);
          await pause(waitMs, signal);
          waitMs = Math.min(waitMs * 2, retryCapMs);
          continue;
        }
        // Both receive until the old one is let go, so an event sent in between is taken by one of them.
        current?.close();
        current = next;
        waitMs = retryFirstMs;
        if (!isReady) announce(next.hello);
        markReady();
        const outcome = await new Promise<"refresh" | "lost">((resolve, reject) => {
          const stopWatching = whenAborted(signal, () => resolve("lost"));
          next.ended.then(
            (value) => {
              stopWatching();
              resolve(value);
            },
            (error: unknown) => {
              stopWatching();
              reject(error);
            },
          );
        });
        if (signal.aborted) break;
        if (outcome === "lost") {
          current = undefined;
          await pause(retryFirstMs, signal);
        }
      }
    } finally {
      // However it ends, including with a failure no retry can fix: a channel that has ended takes no more events.
      current?.close();
    }
  };

  run().then(
    () => {
      markReady();
      closed.resolve();
    },
    (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!isReady) {
        isReady = true;
        ready.reject(failure);
      }
      closed.reject(failure);
    },
  );
  return { ready: ready.promise, closed: closed.promise };
}
