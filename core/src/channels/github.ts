/**
 * GitHub webhook channel: verify → route via `on(event)` → fire-and-forget agent turns, ACK 202.
 * The developer writes only `on`. Concurrency safety is the engine's per-session lease. A turn that
 * fails after the 202, or any in-flight turn on shutdown, is lost (server log only). The agent acts
 * back via `gh`, so the channel holds no outbound credentials beyond `secret` (inbound verification).
 */
import { verify } from "@octokit/webhooks-methods";
import type { Schema } from "@octokit/webhooks-types";
import type { Agent } from "../agent.ts";
import { collect } from "../collect.ts";
import { readBodyCapped } from "./body.ts";

/** Raw body cap before verification — GitHub caps webhook payloads at 25 MB; reject larger early. */
const MAX_WEBHOOK_BYTES = 25 << 20;

/** A verified GitHub webhook event. Header fields plus the official typed payload. */
export interface GithubEvent {
  /** `X-GitHub-Event` (e.g. "pull_request", "issue_comment"). */
  event: string;
  /** `payload.action` (e.g. "opened"), when present — the usual routing discriminant. */
  action?: string;
  /** `X-GitHub-Delivery` — unique per delivery. */
  deliveryId: string;
  /**
   * The native payload, typed via `@octokit/webhooks-types` (the official source). It's the union of
   * all events; narrow it for event-specific fields, e.g. `if ("pull_request" in event.payload)`.
   */
  payload: Schema;
}

/** What `on` returns per acted-on delivery: a session + the prompt text for the agent turn. */
export interface Intent {
  session: string;
  text: string;
}

export interface GithubChannelOptions {
  /** Webhook secret — verifies inbound deliveries (HMAC-SHA256 over the raw body). */
  secret: string;
  /** Map a verified event to the intents this agent acts on (empty array = ignore). */
  on: (event: GithubEvent) => Intent[];
}

const textHeaders = { "content-type": "text/plain" };
const reply = (body: string, status: number): Response => new Response(body, { status, headers: textHeaders });

/**
 * Build a GitHub webhook channel for `agent`: a Fetch handler to mount at your webhook route (POST).
 */
export function githubChannel(agent: Agent, { secret, on }: GithubChannelOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") return reply("POST only\n", 405);
    // Cap before verify: a public endpoint must not buffer an unbounded body (chunked bypasses Content-Length).
    const body = await readBodyCapped(req, MAX_WEBHOOK_BYTES);
    if ("tooLarge" in body) return reply("payload too large\n", 413);
    const raw = body.text;
    // @octokit/webhooks-methods verify (Web Crypto, runtime-agnostic) throws on a missing/empty arg,
    // so fail CLOSED: treat any verify exception (e.g. an empty body) as a clean 401, never a 500.
    // Signature is over the RAW body for both content types.
    // Fail closed: octokit verify throws on empty/missing args — treat any error as 401, not 500.
    // Signature is over the raw body (both content types).
    const signature = req.headers.get("x-hub-signature-256");
    if (!signature || !(await verify(secret, raw, signature).catch(() => false))) {
      return reply("invalid signature\n", 401);
    }

    const eventName = req.headers.get("x-github-event") ?? "";
    if (eventName === "ping") return new Response(null, { status: 204 });
    // x-www-form-urlencoded (GitHub's UI default) wraps the JSON in a `payload` field; json is the body.
    let json = raw;
    if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
      const field = new URLSearchParams(raw).get("payload");
      if (field === null) return reply("missing form payload\n", 400);
      json = field;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return reply("invalid json\n", 400);
    }

    const event: GithubEvent = {
      event: eventName,
      action: typeof payload.action === "string" ? payload.action : undefined,
      deliveryId: req.headers.get("x-github-delivery") ?? "",
      payload: payload as unknown as Schema, // trust boundary: the verified body is a GitHub event
    };

    // Fire each turn, return 202; the long-running process runs them to completion. `.catch` is the
    // only failure sink (server log). Concurrency safety = the engine's per-session lease.
    for (const { session, text } of on(event)) {
      void collect(agent.invoke({ session }, { text })).catch((error) =>
        console.error(`[github] turn failed for ${session}: ${String(error)}`),
      );
    }
    return new Response(null, { status: 202 });
  };
}
