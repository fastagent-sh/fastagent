/**
 * GitHub channel: verified webhook ingress → agent turns, optimized for AI-authored glue.
 *
 * The developer (often an AI coding agent) writes ONLY the routing `on(delivery, run)`: which
 * deliveries map to which `{ session, prompt }`. Everything correctness-critical is implicit and
 * unreachable — HMAC verification, `ping`/unhandled deliveries → 2xx, ACK-early (202 before the
 * turn runs), per-session concurrency (coalesce/serialize), background execution + drain. The point:
 * the failure modes a reviewer keeps catching in hand-written webhook glue (lost ACK timing, dropped
 * re-reviews) are not in the surface, so neither a human nor an AI can write them here.
 *
 * The agent acts back via `gh` (agent-native), so the channel owns no OUTBOUND credentials — only
 * `secret`, for inbound verification. NOT yet solved: a turn that fails AFTER the 202 only surfaces
 * in server logs — the trigger (e.g. the PR author) sees nothing and can't retry, since the channel
 * has no way to report back. Surfacing turn status (a credential resolver / status API) is a later
 * option; until then, failures are observable to operators, not to the responsible party.
 */
import { verify } from "@octokit/webhooks-methods";
import type { Schema } from "@octokit/webhooks-types";
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
  /**
   * The native GitHub event payload, typed via `@octokit/webhooks-types` (the official source). It's
   * the union of all events; narrow it for event-specific fields, e.g. `if ("pull_request" in
   * delivery.payload)` or `if (delivery.payload.action === "opened")`. The pre-extracted fields above
   * cover most routing without narrowing.
   */
  payload: Schema;
}

/**
 * Run the agent for a delivery. Fire-and-ACK-early: schedules the turn, returns immediately.
 * `concurrency` is PER-CALL because one channel routes many event types with different semantics
 * (map your trigger type to a mode):
 *   - "coalesce" (default): only the latest matters — ≤1 in flight per session; deliveries during a
 *     run collapse into one re-run of the LATEST turn afterward (PR push → review latest; rebuild);
 *   - "serialize": every delivery matters, in order — a per-session FIFO queue, one at a time, none
 *     dropped (comment-command bots, command sequences).
 * Both modes gate the session to ≤1 in-flight turn, so the channel never collides on the engine lease.
 * Independent triggers (each delivery is its own task) need no mode — give them distinct sessions.
 * At-most-once (dedup by delivery id) is an orthogonal concern, not a concurrency mode.
 */
export type GithubRun = (turn: { session: string; text: string; concurrency?: "coalesce" | "serialize" }) => void;

export interface GithubChannelOptions {
  /** Webhook secret — verifies inbound deliveries (HMAC-SHA256 over the raw body). */
  secret: string;
  /** Route a verified delivery: call `run({ session, text })` for the deliveries this agent acts on. */
  on: (delivery: GithubDelivery, run: GithubRun) => void | Promise<void>;
}

/**
 * What the handler returns: the 202 to send immediately (ACK-early), plus the post-ACK turn work as
 * `background` — already running, handed to the host to keep alive past the response (serverless
 * `ctx.waitUntil(background)`, or the Node host's `serveNode` which tracks + drains it). `undefined`
 * when the delivery scheduled no new work. Structurally a host `HostResult`, so the returned handler
 * mounts directly in a `Routes` table; kept un-named/internal to avoid a duplicate public type.
 */
type FetchResult = { response: Response; background?: Promise<unknown> };

const textHeaders = { "content-type": "text/plain" };
const reply = (body: string, status: number): Response => new Response(body, { status, headers: textHeaders });

/**
 * Yield a macrotask so `fetch` returns the 202 before ANY turn work begins — including the agent's
 * synchronous setup at the start of `invoke()` (lease/harness/auth). This is the channel's ACK-early
 * guarantee, independent of what `invoke()` does and of which host keeps `background` alive.
 */
const defer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
    // Trust boundary: the verified body is a GitHub event — expose it under the official typed union.
    payload: payload as unknown as Schema,
  };
}

type Turn = () => Promise<void>;
type Concurrency = NonNullable<Parameters<GithubRun>[0]["concurrency"]>;

/** Per-session pending-work holder. One per active session, across modes (see schedule). */
interface Gate {
  /** Fixed by the first delivery for the session (a later mismatch warns; see schedule). */
  mode: "coalesce" | "serialize";
  add(turn: Turn): void;
  take(): Turn | undefined;
  /** The in-flight drain loop's promise — returned to every delivery (starter AND folded) so each
   *  can hand it to its host (e.g. serverless `ctx.waitUntil`), not just the one that started it. */
  loop?: Promise<void>;
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
export function githubChannel(agent: Agent, options: GithubChannelOptions): (req: Request) => Promise<FetchResult> {
  const { secret, on } = options;
  // Fail visibly at construction (startup), not as a 500 on every signed delivery: an unset env var
  // (`secret: process.env.X!`) would otherwise reach verify() as undefined and throw per-request.
  if (typeof secret !== "string" || secret === "") {
    throw new Error(
      "githubChannel: `secret` must be a non-empty string (the webhook secret; e.g. set GITHUB_WEBHOOK_SECRET)",
    );
  }
  if (typeof on !== "function") {
    throw new Error("githubChannel: `on` must be a function (delivery, run) => void | Promise<void>");
  }
  // ONE gate per session, across both modes — so a session never starts a second background loop
  // (which would collide on the engine lease and silently drop a delivery). The gate's mode is fixed
  // by the first delivery for that session; it holds pending work per that mode (coalesce: the latest
  // only; serialize: a FIFO queue).
  const gates = new Map<string, Gate>();

  // The gate runs ≤1 turn per session at a time, and distinct sessions use distinct engine leases, so
  // the channel never collides on the lease — a caught error here is a GENUINE turn failure, not a
  // fail-fast rejection. Surface it (don't wedge/drop the rest), but note it ONLY reaches server logs;
  // the trigger never sees it (see the file header).
  const runTurn = async (session: string, turn: Turn) => {
    try {
      await turn();
    } catch (error) {
      console.error(`[github] turn failed for ${session}: ${String(error)}`);
    }
  };

  // Schedule a session's turn per its trigger type (see GithubRun). Returns the post-ACK loop promise
  // the host must keep alive — for the delivery that STARTS the loop AND for any that fold into it,
  // so a folded turn isn't left relying solely on the starter's host lifetime (serverless waitUntil).
  const schedule = (session: string, concurrency: Concurrency, turn: Turn): Promise<void> | undefined => {
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
      return existing.loop; // fold under the SAME loop, and return it so this delivery's host pins it too
    }
    const gate = makeGate(concurrency, turn);
    gates.set(session, gate);
    gate.loop = (async () => {
      await defer(); // ACK-early: let fetch return the 202 before the turn's setup runs
      try {
        for (let t = gate.take(); t; t = gate.take()) await runTurn(session, t);
      } finally {
        gates.delete(session);
      }
    })();
    return gate.loop;
  };

  const fetch = async (req: Request): Promise<FetchResult> => {
    if (req.method !== "POST") return { response: reply("POST only\n", 405) };
    // Cap the body BEFORE verifying: this endpoint is public/unauthenticated, so an unbounded read
    // would let any client exhaust memory (a Content-Length check is bypassable with chunked bodies).
    const body = await readBodyCapped(req, MAX_WEBHOOK_BYTES);
    if ("tooLarge" in body) return { response: reply("payload too large\n", 413) };
    const raw = body.text;
    // @octokit/webhooks-methods verify (Web Crypto, runtime-agnostic). It throws on missing/empty
    // args, so on this public endpoint fail CLOSED: any non-positive result — including a throw from
    // an empty/malformed body — is a clean 401, never an unhandled 500. Signature is over the RAW body
    // for both content types.
    const signature = req.headers.get("x-hub-signature-256");
    const verified = signature !== null && raw !== "" && (await verify(secret, raw, signature).catch(() => false));
    if (!verified) return { response: reply("invalid signature\n", 401) };

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

  return fetch; // the channel IS a mountable handler (like createInvokeHandler), not a { fetch } wrapper
}
