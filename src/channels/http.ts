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
import type { Agent } from "../agent.ts";
import { readBodyCapped } from "./body.ts";
import { text } from "./respond.ts";

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
    const {
      session,
      text: promptText,
      parentSession,
      branchHints,
    } = (payload ?? {}) as { session?: unknown; text?: unknown; parentSession?: unknown; branchHints?: unknown };
    if (typeof session !== "string" || typeof promptText !== "string") {
      return text('need { "session": string, "text": string }\n', 400);
    }
    // ^ the request shape INVOKE_EXAMPLE_BODY (below) must keep satisfying.
    // The OPTIONAL lineage extension (Scope): malformed values are a 400, not a silent drop — a
    // caller that sent them meant them.
    if (parentSession !== undefined && typeof parentSession !== "string") {
      return text('"parentSession" must be a string\n', 400);
    }
    if (branchHints !== undefined && !(Array.isArray(branchHints) && branchHints.every((h) => typeof h === "string"))) {
      return text('"branchHints" must be an array of strings\n', 400);
    }

    // Take the iterator explicitly so the stream's cancel() (consumer disconnect) can return() it and
    // run invoke's cancellation cleanup (SPEC MUST 3). pull = backpressure: the next event is produced on demand.
    const iterator = agent
      .invoke(
        {
          session,
          ...(parentSession !== undefined ? { parentSession } : {}),
          ...(branchHints !== undefined ? { branchHints } : {}),
        },
        { text: promptText },
      )
      [Symbol.asyncIterator]();
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
