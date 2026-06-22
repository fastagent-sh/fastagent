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
import type { Agent } from "../agent.ts";
import { collect } from "../collect.ts";
import { readBodyCapped } from "./body.ts";

/** Raw body cap before verification — GitHub caps webhook payloads at 25 MB; reject larger early. */
const MAX_WEBHOOK_BYTES = 25 << 20;

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

/**
 * Verify GitHub's `X-Hub-Signature-256` against the body HMAC, using Web Crypto so the channel loads
 * on any runtime (Node / Cloudflare / Deno / Bun) — no `node:crypto`/`Buffer`, matching its
 * platform-agnostic contract. Constant-time compare is kept explicit (the recompute-and-compare
 * shape), not delegated to an unspecified primitive.
 */
async function verify(raw: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const provided = hexToBytes(signature.slice("sha256=".length));
  if (!provided) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
  return timingSafeEqualBytes(provided, expected);
}

/** Constant-time byte compare (length-dependent only, like node's timingSafeEqual on equal lengths). */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Parse a lowercase/uppercase hex string to bytes; null on any non-hex/odd-length input. */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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
    // Cap the body BEFORE verifying: this endpoint is public/unauthenticated, so an unbounded read
    // would let any client exhaust memory (a Content-Length check is bypassable with chunked bodies).
    const body = await readBodyCapped(req, MAX_WEBHOOK_BYTES);
    if ("tooLarge" in body) return { response: reply("payload too large\n", 413) };
    const raw = body.text;
    if (!(await verify(raw, req.headers.get("x-hub-signature-256"), secret)))
      return { response: reply("invalid signature\n", 401) };

    const event = req.headers.get("x-github-event") ?? "";
    if (event === "ping") return { response: new Response(null, { status: 204 }) }; // GitHub setup ping
    // GitHub signs the raw body for BOTH content types. With `application/x-www-form-urlencoded`
    // (GitHub's webhook-UI default), the JSON lives in a URL-encoded `payload` field, not the body
    // itself — parsing the raw form string as JSON would 400 every such delivery.
    let json = raw;
    if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
      const field = new URLSearchParams(raw).get("payload");
      if (field === null) return { response: reply("missing form payload\n", 400) };
      json = field;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return { response: reply("invalid json\n", 400) };
    }

    // Routing only RECORDS turns; none start until `on` fully resolves. `on` may be async and await
    // after calling `run` (telemetry, a lookup) — if a turn started at `run` time, its deferred work
    // could begin while `fetch` is still awaiting `on`, breaking ACK-early for async routing.
    const requests: { session: string; concurrency: Concurrency; turn: Turn }[] = [];
    const delivery = toDelivery(event, req.headers.get("x-github-delivery") ?? "", payload);
    const run: GithubRun = ({ session, text, concurrency = "coalesce" }) => {
      requests.push({
        session,
        concurrency,
        turn: async () => {
          await collect(agent.invoke({ session }, { text })); // throws AgentFailure on a failed turn → sink
        },
      });
    };
    await on(delivery, run);

    // Routing done — now schedule. schedule still defers each turn past this response (ACK-early).
    const started: Promise<unknown>[] = [];
    for (const r of requests) {
      const work = schedule(r.session, r.concurrency, r.turn);
      if (work) started.push(work);
    }
    return {
      response: new Response(null, { status: 202 }),
      background: started.length ? Promise.allSettled(started) : undefined,
    };
  };

  return { fetch };
}
