/**
 * HTTP/SSE channel: fan one invoke stream out to Server-Sent Events.
 *
 * The handler is Fetch-shaped (`(Request) => Promise<Response>`) — the cross-runtime form every
 * embedding host speaks, so it mounts inside an existing app's own route. It is path-agnostic. The
 * web stream primitives give cancellation (consumer disconnect → cancel() → iterator.return() →
 * invoke cancellation, SPEC MUST 3), backpressure (pull-based), and the body cap natively.
 *
 * Serving it is somebody else's job: the node:http bridge and the route table belong to the HOST
 * (`./serve.ts`). This file knows only the Agent contract and the wire shape of one stream.
 */
import type { Agent } from "../agent.ts";
import { readBodyCapped } from "./body.ts";
import { text } from "./respond.ts";
import { sseResponse } from "./sse.ts";

/** Request body cap (1 MiB) — shared by every Prompt-bearing wire surface (the control plane's
 *  dispatch imports it), so the two caps cannot drift apart. */
export const MAX_BODY_BYTES = 1 << 20;

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
    // INVOKE_EXAMPLE_BODY must keep satisfying this request shape.
    // The OPTIONAL lineage extension (Scope): malformed values are a 400, not a silent drop — a
    // caller that sent them meant them.
    if (parentSession !== undefined && typeof parentSession !== "string") {
      return text('"parentSession" must be a string\n', 400);
    }
    if (branchHints !== undefined && !(Array.isArray(branchHints) && branchHints.every((h) => typeof h === "string"))) {
      return text('"branchHints" must be an array of strings\n', 400);
    }

    return sseResponse(
      agent.invoke(
        {
          session,
          ...(parentSession !== undefined ? { parentSession } : {}),
          ...(branchHints !== undefined ? { branchHints } : {}),
        },
        { text: promptText },
      ),
    );
  };
}
