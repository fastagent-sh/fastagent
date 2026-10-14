/**
 * The client half of a server-sent event stream, for every remote client: a read budget that tells a slow host from a
 * dead one, the connect sequence under it, the SSE reader, and why a stream ended.
 */
import { SSE_HEARTBEAT_MS } from "./channels/sse.ts";

/**
 * Dead-connection watchdog for SSE reads: the server heartbeats every SSE_HEARTBEAT_MS, so a PENDING READ seeing no
 * bytes (of ANY kind — comments included) for this many missed beats means the connection is a black hole.
 */
const SSE_IDLE_LIMIT_MS = 3 * SSE_HEARTBEAT_MS;

/**
 * Every request carries a TIMEOUT: a client's reliability model counts failed rounds against a budget ("unreachable
 * for ~Ns"), which a black-hole endpoint (firewall drop, half-dead tunnel) would silently defeat — a hung
 * state()/entries(), or a stream that never finishes connecting, ticks nothing.
 */
export const REQUEST_TIMEOUT_MS = 10_000;
/** The PAYLOAD-bearing calls get a longer budget than the black-hole detector's 10s. */
export const PAYLOAD_TIMEOUT_MS = 60_000;

/**
 * WHY a stream connection ended, carried BY the abort that ended it.
 *
 * Three independent deciders abort one connection — the consumer walking away, a phase deadline, the idle watchdog —
 * and every reader afterwards (the generator's catch, `ready`, the invoke plane's terminal) needs to know which.
 * `AbortSignal.reason` carries it: `fetch` and `reader.read()` reject with the reason OBJECT itself (verified on
 * Node 22.19 and 26), and a second bare `abort()` does not overwrite it — so the decider states the reason once and
 * nobody infers it.
 */
export type StreamEndKind = "cancelled" | "connect-timeout" | "idle";
export class StreamEnded extends Error {
  readonly kind: StreamEndKind;
  constructor(kind: StreamEndKind, message: string) {
    super(message);
    this.name = "StreamEnded";
    this.kind = kind;
  }
}

/** The reason this connection was ended, when one was given — `undefined` for any other failure. */
export function endedBecause(signal: AbortSignal): StreamEnded | undefined {
  return signal.reason instanceof StreamEnded ? signal.reason : undefined;
}

/**
 * ONE limit on a pending read, whose value depends on the phase — the only question either wire plane asks about
 * time. Before the stream is connected a read rides `connectMs`, the caller's answer to "how long may an endpoint
 * that accepted the socket take to answer": the events plane gives it the black-hole budget every other request
 * carries ({@link REQUEST_TIMEOUT_MS}), because a reconnecting client WAITS on that phase, so a black-hole endpoint
 * has to be declared dead inside its retry budget; the invoke plane gives it the payload one ({@link PAYLOAD_TIMEOUT_MS}), because a
 * scale-to-zero host legitimately holds a POST open while a machine boots. Once connected the limit becomes the
 * heartbeat one for both, which is the right answer for a stream that is merely quiet.
 *
 * It counts only while ARMED — armed means a read is actually pending (the connect awaiting headers or its error
 * body, a body read awaiting bytes), never while the consumer is simply not pulling.
 */
export interface ReadBudget {
  arm(): void;
  disarm(): void;
  /** The connect phase is over: later reads ride the idle limit instead. */
  connected(): void;
}
export function readBudget(abort: AbortController, what: string, connectMs: number): ReadBudget {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connected = false;
  const expire = (): void =>
    abort.abort(
      connected
        ? new StreamEnded(
            "idle",
            `${what}: no bytes for ${SSE_IDLE_LIMIT_MS / 1000}s (heartbeats absent) — dead connection`,
          )
        : new StreamEnded(
            "connect-timeout",
            `${what}: no usable response in ${connectMs / 1000}s — the endpoint accepted the connection and never completed one`,
          ),
    );
  const disarm = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    // `??=`: a nested arm does not restart the clock, so one long read cannot be extended by re-arming inside it.
    arm: () => {
      timer ??= setTimeout(expire, connected ? SSE_IDLE_LIMIT_MS : connectMs);
    },
    disarm,
    connected: () => {
      disarm();
      connected = true;
    },
  };
}

/**
 * Open a streaming response — the one connect sequence both wire planes perform, under one budget: the headers, the
 * error body of a non-2xx (a half-dead tunnel answering 4xx and then black-holing the body is the case that makes
 * this one phase rather than two), and the check that a body exists at all. It returns only once the connection is
 * something that can carry events, which is the moment the budget switches to the idle limit.
 */
export async function openStreamBody(options: {
  fetchFn: typeof fetch;
  url: string;
  init: RequestInit;
  abort: AbortController;
  budget: ReadBudget;
  what: string;
  /** What a non-2xx reply is: each protocol reads its own error body. */
  refused: (res: Response) => Promise<Error>;
}): Promise<ReadableStream<Uint8Array>> {
  const { fetchFn, url, init, abort, budget, what, refused } = options;
  budget.arm(); // the connect await is a pending read
  const res = await fetchFn(url, { ...init, signal: abort.signal });
  if (!res.ok) throw await refused(res);
  if (!res.body) throw new Error(`${what}: response has no body`);
  budget.connected();
  return res.body;
}

/** Base64 without `Buffer` (this module runs in any Fetch runtime), in chunks: spreading megabytes of bytes into one
 *  `String.fromCharCode` call overflows the argument limit. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Minimal SSE reader: yields each `data:` payload; ignores comments (heartbeats) and other fields. */
export async function* sseData(body: ReadableStream<Uint8Array>, watch?: ReadBudget): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      watch?.arm(); // a read is pending — the idle clock may run
      const { done, value } = await reader.read();
      watch?.disarm(); // bytes (ANY bytes — heartbeats included) or a clean end arrived
      if (done) return;
      // SSE permits CRLF line endings (proxies/other servers may produce them).
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data !== "") yield data;
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
