/**
 * HTTP/SSE channel: fan one invoke stream out to Server-Sent Events.
 *
 * The handler is Fetch-shaped (`(Request) => Promise<Response>`) — the cross-runtime form every
 * embedding host speaks, so it mounts inside an existing app's own route. It is path-agnostic. The
 * web stream primitives give cancellation (consumer disconnect → cancel() → iterator.return() →
 * invoke cancellation), backpressure (pull-based), and the body cap natively.
 *
 * `nodeListener` is the thin node:http adapter for the standalone `fastagent dev/start` server.
 */
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "../agent.ts";
import { readBodyCapped } from "./body.ts";
import { text, textHeaders } from "./respond.ts";

/** Request body cap (1 MiB). */
const MAX_BODY_BYTES = 1 << 20;

const encoder = new TextEncoder();

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

    // Take the iterator explicitly so the stream's cancel() (consumer disconnect) can return() it and
    // run invoke's cancellation cleanup. pull = backpressure: the next event is produced on demand.
    const iterator = agent.invoke({ session }, { text: promptText })[Symbol.asyncIterator]();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      },
      async cancel() {
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
    void pump(handler, req, res);
  };
}

async function pump(
  handler: (req: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
    else if (v != null) headers.set(k, v);
  }

  let response: Response;
  try {
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit & { duplex: "half" });
    response = await handler(request);
  } catch (error) {
    // Log server-side (some channels' only failure sink), but return a generic body — don't leak the
    // internal message to the client.
    console.error(`[host] request handler failed: ${String(error)}`);
    if (!res.headersSent) res.writeHead(500, textHeaders);
    res.end("internal error\n");
    return;
  }

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
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      // Backpressure: wait for drain, but ALSO resolve on close. A client disconnect after write()
      // returned false never emits 'drain' on the closed socket, so waiting on 'drain' alone would
      // suspend pump() forever (leaking the request/stream).
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      }
    }
  } finally {
    if (!res.destroyed) res.end();
  }
}
