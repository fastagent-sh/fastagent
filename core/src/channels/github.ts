/**
 * GitHub channel: verified webhook ingress → agent turns, optimized for AI-authored glue.
 *
 * The developer (often an AI coding agent) writes ONLY the routing `on(delivery, run)`: which
 * deliveries map to which `{ session, prompt }`. Everything correctness-critical is implicit and
 * unreachable — HMAC verification, `ping`/unhandled deliveries → 2xx, ACK-early (202 before the
 * turn runs), per-session concurrency (coalesce-to-latest), background execution + drain. The point:
 * the failure modes a reviewer keeps catching in hand-written webhook glue (lost ACK timing, dropped
 * re-reviews, swallowed failures) are not in the surface, so neither a human nor an AI can write
 * them here.
 *
 * The agent acts back via `gh` (agent-native), so the channel owns no OUTBOUND credentials — only
 * `secret`, for inbound verification. (A credential resolver / typed tools are a later option.)
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Agent } from "../agent.ts";
import { collect } from "../collect.ts";
import { createTrackedBackground } from "./background.ts";

/** A verified delivery: common fields pre-extracted for ergonomic routing, plus the raw payload. */
export interface GithubDelivery {
  /** `X-GitHub-Event` (e.g. "pull_request", "issue_comment"). */
  event: string;
  /** `payload.action` (e.g. "opened"), when present. */
  action?: string;
  /** `X-GitHub-Delivery` — unique per delivery (for app-level dedup, if ever needed). */
  deliveryId: string;
  /** "owner/repo", from `payload.repository.full_name`, when present. */
  repo?: string;
  /** PR or issue number, when present. */
  number?: number;
  /** `payload.sender.login`, when present. */
  sender?: string;
  /** `payload.installation.id` (GitHub App), when present. */
  installationId?: number;
  /** The raw native GitHub payload — for anything beyond the pre-extracted fields. */
  payload: Record<string, unknown>;
}

/**
 * Run the agent for a delivery. Fire-and-ACK-early: schedules the turn, returns immediately.
 * `concurrency` is PER-CALL because one channel routes many event types with different semantics
 * (map your trigger type to a mode):
 *   - "coalesce" (default): only the latest matters — ≤1 in flight per session; deliveries during a
 *     run collapse into one re-run of the LATEST turn afterward (PR push → review latest; rebuild);
 *   - "serialize": every delivery matters, in order — a per-session FIFO queue, one at a time, none
 *     dropped (comment-command bots, command sequences);
 *   - "reject": fail-fast via the engine lease (a second concurrent same-session turn fails).
 * Independent triggers (each delivery is its own task) need no mode — give them distinct sessions.
 * At-most-once (dedup by delivery id) is an orthogonal concern, not a concurrency mode.
 */
export type GithubRun = (turn: {
  session: string;
  text: string;
  concurrency?: "coalesce" | "serialize" | "reject";
}) => void;

export interface GithubChannelOptions {
  /** Webhook secret — verifies inbound deliveries (HMAC-SHA256 over the raw body). */
  secret: string;
  /** Route a verified delivery: call `run({ session, text })` for the deliveries this agent acts on. */
  on: (delivery: GithubDelivery, run: GithubRun) => void | Promise<void>;
}

export interface GithubChannel {
  /** Fetch-shaped handler — mount at your webhook route (POST). */
  fetch: (req: Request) => Promise<Response>;
  /** Await in-flight turns on shutdown — call on SIGTERM before exit so none are dropped. */
  drain: () => Promise<void>;
}

const textHeaders = { "content-type": "text/plain" };
const reply = (body: string, status: number): Response => new Response(body, { status, headers: textHeaders });

/** Constant-time compare of GitHub's `X-Hub-Signature-256` against the body HMAC. */
function verify(raw: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pre-extract the common fields from a native GitHub payload (no full normalization). */
function toDelivery(event: string, deliveryId: string, payload: Record<string, unknown>): GithubDelivery {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const repository = obj(payload.repository);
  const pull = obj(payload.pull_request);
  const issue = obj(payload.issue);
  const sender = obj(payload.sender);
  const installation = obj(payload.installation);
  const num = pull.number ?? issue.number ?? payload.number;
  return {
    event,
    action: typeof payload.action === "string" ? payload.action : undefined,
    deliveryId,
    repo: typeof repository.full_name === "string" ? repository.full_name : undefined,
    number: typeof num === "number" ? num : undefined,
    sender: typeof sender.login === "string" ? sender.login : undefined,
    installationId: typeof installation.id === "number" ? installation.id : undefined,
    payload,
  };
}

type Turn = () => Promise<void>;
type Concurrency = NonNullable<Parameters<GithubRun>[0]["concurrency"]>;

/**
 * Build a GitHub channel for `agent`. Returns a Fetch handler to mount and a `drain` for shutdown.
 * All correctness-critical machinery (verify, ACK-early, per-session concurrency, background, drain)
 * is internal.
 */
export function githubChannel(agent: Agent, options: GithubChannelOptions): GithubChannel {
  const { secret, on } = options;
  const { background, drain } = createTrackedBackground();
  const coalescing = new Map<string, { dirty: boolean; latest: Turn }>(); // per session, coalesce mode
  const queues = new Map<string, Turn[]>(); // per session, serialize mode

  // A failed turn must never wedge or silently drop a session's pending work: surface it, keep going.
  const runTurn = async (session: string, turn: Turn) => {
    try {
      await turn();
    } catch (error) {
      console.error(`[github] turn failed for ${session}: ${String(error)}`);
    }
  };

  // Schedule a session's turn per its trigger type (see GithubRun).
  const schedule = (session: string, concurrency: Concurrency, turn: Turn) => {
    if (concurrency === "reject") {
      background(turn); // a concurrent same-session turn hits the engine lease and fails fast
      return;
    }
    if (concurrency === "serialize") {
      const q = queues.get(session);
      if (q) {
        q.push(turn); // a drain loop is active for this session → enqueue, run in arrival order
        return;
      }
      const queue: Turn[] = [turn];
      queues.set(session, queue);
      background(async () => {
        try {
          while (queue.length > 0) await runTurn(session, queue.shift() as Turn);
        } finally {
          queues.delete(session);
        }
      });
      return;
    }
    // coalesce (default): ≤1 in flight; deliveries during a run collapse into one re-run of the LATEST.
    const cur = coalescing.get(session);
    if (cur) {
      cur.latest = turn;
      cur.dirty = true;
      return;
    }
    const st = { dirty: false, latest: turn };
    coalescing.set(session, st);
    background(async () => {
      try {
        do {
          st.dirty = false;
          await runTurn(session, st.latest);
        } while (st.dirty);
      } finally {
        coalescing.delete(session);
      }
    });
  };

  const fetch = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return reply("POST only\n", 405);
    const raw = await req.text();
    if (!verify(raw, req.headers.get("x-hub-signature-256"), secret)) return reply("invalid signature\n", 401);

    const event = req.headers.get("x-github-event") ?? "";
    if (event === "ping") return new Response(null, { status: 204 }); // GitHub setup ping
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return reply("invalid json\n", 400);
    }

    const delivery = toDelivery(event, req.headers.get("x-github-delivery") ?? "", payload);
    const run: GithubRun = ({ session, text, concurrency = "coalesce" }) => {
      schedule(session, concurrency, async () => {
        await collect(agent.invoke({ session }, { text })); // throws AgentFailure on a failed turn → sink
      });
    };
    await on(delivery, run); // app routing only; schedules ACK-early work, never blocks on the turn
    return new Response(null, { status: 202 });
  };

  return { fetch, drain };
}
