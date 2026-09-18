/**
 * HTTP/SSE channel: fan one invoke stream out to Server-Sent Events. The web stream primitives supply cancellation
 * natively (consumer disconnect → `cancel()` → `iterator.return()` → invoke cancellation, SPEC MUST 3), backpressure,
 * and the body cap.
 */
import type { Agent } from "../agent.ts";
import { readBodyCapped } from "./body.ts";
import { text, withCors } from "./respond.ts";
import { sseResponse } from "./sse.ts";

/**
 * Request body cap (1 MiB) — shared by every Prompt-bearing wire surface (the control plane's dispatch imports it), so
 * the two caps cannot drift apart.
 */
export const MAX_BODY_BYTES = 1 << 20;

/**
 * A valid example request body for the invoke handler — lives HERE, next to the shape check it must satisfy, so the
 * CLI's "try it" hint can't drift from the protocol.
 */
export const INVOKE_EXAMPLE_BODY = '{"session":"dev","text":"hello"}';

/** The methods `POST /invoke` answers — the CORS preflight's allowance, and what a wrong method is told. */
const INVOKE_METHODS = "POST, OPTIONS";

/** Fetch-shaped invoke handler. */
export function createInvokeHandler(agent: Agent): (req: Request) => Promise<Response> {
  const handle = async (req: Request): Promise<Response> => {
    // A preflight is answered before anything else: it carries no body and names no session.
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
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
  // THE single exit — every reply above leaves through it, the same shape the control plane's mount uses.
  return async (req) => withCors(await handle(req), INVOKE_METHODS);
}
