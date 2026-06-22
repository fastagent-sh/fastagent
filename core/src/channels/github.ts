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

/**
 * Execution-lifetime runner for the ACK-early turn (the Caller-side host port). It must run the
 * task to completion after the 202 is sent.
 */
export interface GithubChannelOptions {
  /** Webhook secret — verifies inbound deliveries (HMAC-SHA256 over the raw body). */
  secret: string;
  /** Route a verified delivery: call `run({ session, text })` for the deliveries this agent acts on. */
  on: (delivery: GithubDelivery, run: GithubRun) => void | Promise<void>;
}

export interface GithubFetchResult {
  /** Return to the client immediately (ACK-early: 202 before the turn runs). */
  response: Response;
  /**
   * Post-ACK work that MUST run to completion (the agent turn[s]) — already running, declared back to
   * the host so it keeps execution alive past the response. The channel states the requirement; the
   * host satisfies it with its platform mechanism: serverless via `ctx.waitUntil(background)`, a
   * long-running host via `inProcessHost` (tracked + drained on shutdown). `undefined` when the
   * delivery scheduled no new work.
   */
  background?: Promise<unknown>;
}

export interface GithubChannel {
  /** Fetch-shaped handler — mount at your webhook route (POST). Returns the response + any post-ACK work. */
  fetch: (req: Request) => Promise<GithubFetchResult>;
}

const textHeaders = { "content-type": "text/plain" };
const reply = (body: string, status: number): Response => new Response(body, { status, headers: textHeaders });

/**
 * Yield a macrotask so `fetch` returns the 202 before ANY turn work begins — including the agent's
 * synchronous setup at the start of `invoke()` (lease/harness/auth). This is the channel's ACK-early
 * guarantee, independent of what `invoke()` does and of which host keeps `background` alive.
 */
const defer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

/** Per-session pending-work holder. One per active session, across modes (see schedule). */
interface Gate {
  /** Fixed by the first delivery for the session; "reject" never uses a gate. */
  mode: "coalesce" | "serialize";
  add(turn: Turn): void;
  take(): Turn | undefined;
}

function makeGate(mode: "coalesce" | "serialize", first: Turn): Gate {
  if (mode === "serialize") {
    // Every delivery, in arrival order — a FIFO queue.
    const q: Turn[] = [first];
    return {
      mode,
      add: (t) => {
        q.push(t);
      },
      take: () => q.shift(),
    };
  }
  // Coalesce — only the latest matters; deliveries during a run collapse into the next take.
  let latest: Turn | undefined = first;
  return {
    mode,
    add: (t) => {
      latest = t;
    },
    take: () => {
      const t = latest;
      latest = undefined;
      return t;
    },
  };
}

/**
 * Build a GitHub channel for `agent`. Returns a Fetch handler to mount and a `drain` for shutdown.
 * All correctness-critical machinery (verify, ACK-early, per-session concurrency, background, drain)
 * is internal.
 */
export function githubChannel(agent: Agent, options: GithubChannelOptions): GithubChannel {
  const { secret, on } = options;
  // ONE gate per session, across all modes — so a session never starts a second background loop
  // (which would collide on the engine lease and silently drop a delivery). The gate's mode is fixed
  // by the first delivery for that session; it holds pending work per that mode (coalesce: the latest
  // only; serialize: a FIFO queue).
  const gates = new Map<string, Gate>();

  // A failed turn must never wedge or silently drop a session's pending work: surface it, keep going.
  const runTurn = async (session: string, turn: Turn) => {
    try {
      await turn();
    } catch (error) {
      console.error(`[github] turn failed for ${session}: ${String(error)}`);
    }
  };

  // Schedule a session's turn per its trigger type (see GithubRun). Returns the post-ACK promise the
  // host must keep alive when this delivery STARTS new work, or undefined when it folds into a loop
  // already in flight (that loop's promise was returned to the delivery that started it).
  const schedule = (session: string, concurrency: Concurrency, turn: Turn): Promise<void> | undefined => {
    if (concurrency === "reject") {
      // a concurrent same-session turn hits the engine lease and fails fast (after the ACK)
      return (async () => {
        await defer();
        await runTurn(session, turn);
      })();
    }
    const existing = gates.get(session);
    if (existing) {
      if (existing.mode !== concurrency) {
        // Mixing modes on one session is incoherent (is it "latest wins" or "all in order"?). Keep
        // the first mode and surface the mismatch — never silently drop the delivery.
        console.warn(
          `[github] session "${session}" mixes concurrency modes ("${existing.mode}" then "${concurrency}"); using "${existing.mode}"`,
        );
      }
      existing.add(turn);
      return undefined; // the in-flight loop (already declared to the host) will run it
    }
    const gate = makeGate(concurrency, turn);
    gates.set(session, gate);
    return (async () => {
      await defer(); // ACK-early: let fetch return the 202 before the turn's setup runs
      try {
        for (let t = gate.take(); t; t = gate.take()) await runTurn(session, t);
      } finally {
        gates.delete(session);
      }
    })();
  };

  const fetch = async (req: Request): Promise<GithubFetchResult> => {
    if (req.method !== "POST") return { response: reply("POST only\n", 405) };
    const raw = await req.text();
    if (!verify(raw, req.headers.get("x-hub-signature-256"), secret))
      return { response: reply("invalid signature\n", 401) };

    const event = req.headers.get("x-github-event") ?? "";
    if (event === "ping") return { response: new Response(null, { status: 204 }) }; // GitHub setup ping
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { response: reply("invalid json\n", 400) };
    }

    // Collect the post-ACK work this delivery STARTS, declared back to the host to keep alive.
    const started: Promise<unknown>[] = [];
    const delivery = toDelivery(event, req.headers.get("x-github-delivery") ?? "", payload);
    const run: GithubRun = ({ session, text, concurrency = "coalesce" }) => {
      const work = schedule(session, concurrency, async () => {
        await collect(agent.invoke({ session }, { text })); // throws AgentFailure on a failed turn → sink
      });
      if (work) started.push(work);
    };
    await on(delivery, run); // app routing only; never blocks on the turn

    return {
      response: new Response(null, { status: 202 }),
      background: started.length ? Promise.allSettled(started) : undefined,
    };
  };

  return { fetch };
}

/** Long-running (Node) host adapter: satisfy the channel's `background` in-process, drain on exit. */
export interface InProcessHost {
  /** Run the channel fetch, keep its post-ACK work in-flight in-process, return the Response. */
  handle: (req: Request) => Promise<Response>;
  /** Await in-flight background work on shutdown — call on SIGTERM before exit so none are dropped. */
  drain: () => Promise<void>;
}

/**
 * The long-running host's way to satisfy a channel's `background`: the process stays up, so just keep
 * the promise referenced until it settles, and await outstanding ones on shutdown. (A serverless host
 * satisfies the same `background` differently — `ctx.waitUntil(background)`.)
 */
export function inProcessHost(fetch: GithubChannel["fetch"]): InProcessHost {
  const inFlight = new Set<Promise<unknown>>();
  return {
    handle: async (req) => {
      const { response, background } = await fetch(req);
      if (background) {
        inFlight.add(background);
        void background.finally(() => inFlight.delete(background));
      }
      return response;
    },
    drain: () => Promise.allSettled(inFlight).then(() => {}),
  };
}
