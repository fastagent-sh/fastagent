/**
 * Minimal HTTP channel handler (pure, testable): fans the single invoke stream out to SSE.
 *   - POST /invoke {session,text} → text/event-stream, one `data:` line per AgentEvent;
 *   - client disconnect → iterator.return() → invoke cancellation (SPEC MUST 3);
 *   - concurrent same-session requests → createAgent's fail-fast lease makes the second
 *     one receive `failed{session busy}`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "../agent.ts";

export function createInvokeHandler(agent: Agent) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST" || req.url !== "/invoke") {
      res.writeHead(404, { "content-type": "text/plain" }).end("POST /invoke\n");
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;
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
        res.write(`data: ${JSON.stringify(value)}\n\n`);
      }
    } finally {
      res.end();
    }
  };
}
