/**
 * Webhook channel: turn an inbound webhook (GitHub, Slack, a generic callback, …) into one agent
 * turn. The ACK-early N topology — acknowledge the delivery immediately (202), then run the turn
 * via the `background` port and let the result reach the user out-of-band.
 *
 * Consumes ONLY the Agent contract (+ collect + the background port). Zero engine coupling: it
 * works with any Agent. The per-platform glue (verify, parse, map, optional delivery) is the
 * {@link WebhookBinding} the caller supplies.
 *
 * `parse` returns one of three outcomes so a binding can act, ignore, or reject a delivery (real
 * webhooks send many event types and redeliveries; an ignored/duplicate one must be ACKed 2xx, not
 * 4xx, or the provider retries it).
 *
 * Two failure planes:
 *   - pre-ACK: parse rejects (bad/unauthorized) → 4xx; parse throws (unexpected fault) → 400;
 *   - post-ACK: the turn fails → `binding.onError` out-of-band (the 202 already went out).
 *
 * Delivery is OPTIONAL: a "fat" agent posts its own result via tools (e.g. `gh pr review`), so the
 * binding need deliver nothing; a "thin" agent returns text the binding posts in `deliver`.
 */
import type { Agent, Prompt, Scope } from "../agent.ts";
import { AgentFailure, collect, type CollectResult } from "../collect.ts";
import type { BackgroundRunner } from "./background.ts";

const textHeaders = { "content-type": "text/plain" };

/**
 * What `parse` decided about a delivery:
 *   - `invoke` — run the agent on `event` (→ 202);
 *   - `ignore` — valid but no work (a duplicate, or an event type this binding doesn't handle) → 200
 *     no-op; the delivery is ACKed so the provider doesn't retry it;
 *   - `reject` — bad/unauthorized request → 4xx (default 401).
 */
export type WebhookOutcome<E> =
  | { action: "invoke"; event: E }
  | { action: "ignore" }
  | { action: "reject"; status?: number };

/** Per-platform glue. One impl per platform (GitHub, Slack, generic callback). */
export interface WebhookBinding<E> {
  /**
   * Verify the request (signature, etc.) and classify it: invoke / ignore / reject (see
   * {@link WebhookOutcome}). Throwing signals an unexpected fault (unreadable body) → 400; an
   * expected bad/unauthorized request is `{ action: "reject" }`, not a throw.
   */
  parse(req: Request): Promise<WebhookOutcome<E>>;
  /** Map the event to an invocation. `scope.session` is derived from the payload. */
  toInvocation(event: E): { scope: Scope; prompt: Prompt };
  /**
   * Deliver the result out-of-band (OPTIONAL). Omit it when the agent posts its own result via
   * tools; provide it for a thin agent whose text/data the binding posts back.
   */
  deliver?(event: E, result: CollectResult): Promise<void>;
  /** Deliver a turn failure out-of-band (OPTIONAL). `retryable` is the platform-retry signal. */
  onError?(event: E, failure: AgentFailure): Promise<void>;
}

/**
 * Fetch-shaped webhook handler. Mount at any route; POST only. ACKs `202` immediately and runs the
 * turn via `background`; the result reaches the user through the agent's own tools and/or
 * `binding.deliver`.
 */
export function createWebhookHandler<E>(
  agent: Agent,
  binding: WebhookBinding<E>,
  background: BackgroundRunner,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") return new Response("POST only\n", { status: 405, headers: textHeaders });

    let outcome: WebhookOutcome<E>;
    try {
      outcome = await binding.parse(req);
    } catch (error) {
      // parse throwing is an UNEXPECTED fault (unreadable body, etc.), not a deliberate reject —
      // answer 400, before any ACK. An expected bad request is `{ action: "reject" }` below.
      return new Response(`bad request: ${(error as Error).message}\n`, { status: 400, headers: textHeaders });
    }
    // A valid-but-skipped delivery (duplicate / unhandled event type) MUST be ACKed 2xx, or the
    // provider keeps retrying it; only a bad/unauthorized request gets 4xx.
    if (outcome.action === "reject") {
      return new Response("rejected\n", { status: outcome.status ?? 401, headers: textHeaders });
    }
    if (outcome.action === "ignore") return new Response(null, { status: 200 });
    const { event } = outcome;

    const { scope, prompt } = binding.toInvocation(event);

    // ACK-early: hand the turn to the host's background runner, which MUST run it to completion.
    background(async () => {
      try {
        const result = await collect(agent.invoke(scope, prompt)); // buffered + terminal discipline
        await binding.deliver?.(event, result);
      } catch (error) {
        // A turn failure with an onError handler is delivered out-of-band. WITHOUT a handler it must
        // still be visible: rethrow so it reaches the background runner's error sink, same as a real
        // bug — never swallow it (fail visibly). For a fat agent this is the case where the agent
        // crashed before posting anything, so the failure especially must not vanish.
        if (error instanceof AgentFailure && binding.onError) await binding.onError(event, error);
        else throw error;
      }
    });

    return new Response(null, { status: 202 });
  };
}
