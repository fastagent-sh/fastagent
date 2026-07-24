/**
 * HTTP/SSE channel: fan one invoke stream out to Server-Sent Events.
 *
 * The handler is Fetch-shaped (`(Request) => Promise<Response>`) — the cross-runtime form every
 * embedding host speaks, so it mounts inside an existing app's own route. It is path-agnostic. The
 * web stream primitives give cancellation (consumer disconnect → cancel() → iterator.return() →
 * invoke cancellation, SPEC MUST 3), backpressure (pull-based), and the body cap natively.
 *
 * `nodeListener` is the thin node:http adapter for the embedded `fastagent dev/start` server.
 */
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "../agent.ts";
import { log } from "../log.ts";
import { readBodyCapped } from "./body.ts";
import { text, textHeaders } from "./respond.ts";

/** Request body cap (1 MiB) — shared by every Prompt-bearing wire surface (the control plane's
 *  dispatch imports it), so the two caps cannot drift apart. */
export const MAX_BODY_BYTES = 1 << 20;

const encoder = new TextEncoder();

/** SSE comment-heartbeat interval, shared by every SSE surface (the control events route imports
 *  it, and the remote client sizes its dead-connection watchdog as a multiple of it). */
export const SSE_HEARTBEAT_MS = 30_000;

/** The emitting half of the heartbeat contract (the client watchdog is the other): starts the
 *  `: ping` comment interval on an SSE stream controller and returns its stop function — ONE
 *  implementation for every SSE surface, so the emission side cannot regress on one route while
 *  the shared client watchdog keeps assuming it. Self-stops if the controller is already closed. */
export function sseHeartbeat(controller: ReadableStreamDefaultController<Uint8Array>): () => void {
  const encoder = new TextEncoder();
  const timer = setInterval(() => {
    try {
      controller.enqueue(encoder.encode(": ping\n\n"));
    } catch {
      clearInterval(timer);
    }
  }, SSE_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/** A valid example request body for the invoke handler — lives HERE, next to the shape check it must
 *  satisfy, so the CLI's "try it" hint can't drift from the protocol. */
export const INVOKE_EXAMPLE_BODY = '{"session":"dev","text":"hello"}';

/**
 * Fetch-shaped invoke handler. Mount it at any route in the host app; it accepts POST only.
 * Returns SSE (`text/event-stream`) with one `data:` line per AgentEvent.
 */
export function createInvokeHandler(agent: Agent): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") return text("POST only\n", 405);

    const body = await readBodyCapped(req, MAX_BODY_BYTES);
    if ("tooLarge" in body) return text("body too large\n", 413);

    let payload: unknown;
    try {
      payload = JSON.parse(body.text);
    } catch {
      return text("invalid json\n", 400);
    }
    const { session, text: promptText } = (payload ?? {}) as { session?: unknown; text?: unknown };
    if (typeof session !== "string" || typeof promptText !== "string") {
      return text('need { "session": string, "text": string }\n', 400);
    }
    // ^ the request shape INVOKE_EXAMPLE_BODY (below) must keep satisfying.

    // Take the iterator explicitly so the stream's cancel() (consumer disconnect) can return() it and
    // run invoke's cancellation cleanup (SPEC MUST 3). pull = backpressure: the next event is produced on demand.
    const iterator = agent.invoke({ session }, { text: promptText })[Symbol.asyncIterator]();
    // Heartbeats: a QUIET stream (a long tool call, no events) is normal here — remote consumers
    // distinguish "quiet but alive" from a dead connection by byte arrival, so silence must not
    // look identical to a black hole (SSE comments are ignored by spec-conforming parsers).
    let stopHeartbeat = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        stopHeartbeat = sseHeartbeat(controller);
      },
      async pull(controller) {
        const { value, done } = await iterator.next();
        if (done) {
          stopHeartbeat();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      },
      async cancel() {
        stopHeartbeat();
        await iterator.return?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  };
}

/**
 * node:http adapter for a Fetch handler. Bridges IncomingMessage → Request and pumps the
 * Response body back to ServerResponse with backpressure; a client disconnect (`res` close)
 * cancels both the request signal and the response stream (→ invoke cancellation).
 */
export function nodeListener(
  handler: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void pump(handler, req, res); // safe: pump is TOTAL (never rejects) — see its contract below
  };
}

/**
 * Consume ONE request and drive its response to a terminal state. pump is TOTAL: a SINGLE try/catch wraps
 * the whole request→response→stream path, so EVERY failure — a handler throw, a non-Response return
 * (`response.headers` undefined), a header Node rejects, `getReader`, or a body stream that errors
 * mid-flight — ends the response and the returned promise NEVER rejects, which is what lets the
 * `void pump(...)` above be safe. Before any byte goes out (headers not sent) it is a clean 500; once the
 * response is streaming, the only honest signal left is to destroy the socket (truncated stream, not a
 * hang). The process installs no `unhandledRejection` handler by design: robustness against a background
 * throw is each fire-and-forget's OWN contract (fail into a terminal HTTP response here), not a global net
 * that would blanket-swallow.
 */
async function pump(
  handler: (req: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
      else if (v != null) headers.set(k, v);
    }
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit & { duplex: "half" });
    const response = await handler(request);

    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    res.writeHead(response.status, outHeaders);

    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    res.on("close", () => void reader.cancel());
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      // Backpressure: wait for drain, but ALSO resolve on close. A client disconnect after write()
      // returned false never emits 'drain' on the closed socket, so waiting on 'drain' alone would
      // suspend pump() forever (leaking the request/stream).
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const settle = () => {
            res.off("drain", settle);
            res.off("close", settle);
            resolve();
          };
          res.once("drain", settle);
          res.once("close", settle);
        });
      }
    }
    if (!res.destroyed) res.end(); // normal completion
  } catch (error) {
    // The ONE totality boundary: every failure above lands here, so pump never rejects (see the header
    // doc) — which REQUIRES the catch itself not to throw. Don't leak the internal message to the client.
    log.error(`[host] request failed: ${String(error)}`);
    // Never touch an already-terminal res: a client that disconnects during the handler await destroys res
    // (headers not yet sent), and writeHead/end on a dead socket can throw ERR_STREAM_DESTROYED here — which
    // WOULD be the unhandled rejection this boundary exists to kill. One named gate states the invariant;
    // with it the catch is provably non-throwing (writeHead only when !headersSent && !destroyed, destroy is
    // idempotent).
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined); // streaming → truncate (not a hang)
    } else {
      res.writeHead(500, textHeaders); // pre-header → a clean 500
      res.end("internal error\n");
    }
  }
}
