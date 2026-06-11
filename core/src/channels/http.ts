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

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "text/plain" }).end("body too large\n");
        return;
      }
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
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
    // runs its cancellation cleanup (SPEC MUST 3).
    const iterator = agent.invoke({ session }, { text })[Symbol.asyncIterator]();
    req.on("close", () => void iterator.return?.());
    try {
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        await writeWithBackpressure(res, `data: ${JSON.stringify(value)}\n\n`);
      }
    } finally {
      res.end();
    }
  };
}
