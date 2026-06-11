/**
 * Minimal HTTP channel handler (pure, testable): fans the single invoke stream out to SSE.
 *   - POST /invoke {session,text} → text/event-stream, one `data:` line per AgentEvent;
 *   - client disconnect → iterator.return() → invoke cancellation (SPEC MUST 3);
 *   - concurrent same-session requests → the agent's fail-fast lease (invoke.ts) makes
 *     the second one receive `failed{session busy}`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "../agent.ts";

/** Request body cap — prompts are text (+ base64 images later); 1 MiB is generous for v1. */
const MAX_BODY_BYTES = 1 << 20;

/** Write honoring backpressure; waits for drain OR close (never hangs on a dead socket). */
async function writeWithBackpressure(res: ServerResponse, chunk: string): Promise<void> {
  if (res.destroyed) return; // connection already gone; caller's loop exits via done/destroyed check
  if (res.write(chunk)) return;
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

export function createInvokeHandler(agent: Agent) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST" || req.url !== "/invoke") {
      res.writeHead(404, { "content-type": "text/plain" }).end("POST /invoke\n");
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer; // no setEncoding → chunks are Buffers; count real bytes
      received += buf.length;
      if (received > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "text/plain" }).end("body too large\n");
        return;
      }
      chunks.push(buf);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("invalid json\n");
      return;
    }
    const { session, text } = (payload ?? {}) as { session?: unknown; text?: unknown };
    if (typeof session !== "string" || typeof text !== "string") {
      res.writeHead(400, { "content-type": "text/plain" }).end('need { "session": string, "text": string }\n');
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // Take the iterator explicitly: on client disconnect, return() it so invoke
    // runs its cancellation cleanup (SPEC MUST 3). The signal must be the RESPONSE's
    // "close" — req "close" fires when the request message ends (Node ≥15), i.e.
    // right after the body is consumed, NOT on socket teardown; listening there
    // either cancels every request or never fires (covered by the disconnect test).
    // res "close" also fires after normal end — return() on a finished generator
    // is a no-op, so no special-casing.
    const iterator = agent.invoke({ session }, { text })[Symbol.asyncIterator]();
    res.on("close", () => void iterator.return?.());
    try {
      while (true) {
        const { value, done } = await iterator.next();
        if (done || res.destroyed) break;
        await writeWithBackpressure(res, `data: ${JSON.stringify(value)}\n\n`);
      }
    } finally {
      res.end();
    }
  };
}
