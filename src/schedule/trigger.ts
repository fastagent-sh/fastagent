/**
 * `POST /trigger` — **an API**: run a unit of work this definition declares, by name.
 *
 * NOT A TIME TRIGGER, and the difference is the whole design. Occurrence semantics — a slot, a claim, a fire
 * history, an overlap policy — exist exactly where fastagent OWNS the clock: the resident loop in `dev`/`start`,
 * and AgentCore, where `deploy` writes the EventBridge rule, injects the instant and relays it through an ingress
 * secret (channels/agentcore.ts). Both of those know which occurrence a run is for because they produced it.
 *
 * This route is the other case: somebody else's clock, CI job, button or script. It cannot be told which occurrence
 * it means, and pretending otherwise was measurably worse than admitting it. The attempt cost four rounds — an
 * instant dated ahead poisoned the claim gate permanently, one off the grid minted a claim no occurrence would ever
 * match, an old one replayed history a turn at a time, and the grid arithmetic all three needed was ~6ms of
 * synchronous CPU per request on an anonymous route. A platform cron drifting a few minutes then lost an occurrence
 * outright (Railway documents "a few minutes" of variance; measured: 3 fires, 2 turns).
 *
 * So the contract is the one an API has:
 *
 *   - the body names WHAT to run and nothing else — the prompt stays in the definition, which is the whole reason
 *     this exists beside `POST /invoke`, whose caller brings its own text and therefore its own behaviour
 *   - `idempotencyKey` is OPTIONAL and OPAQUE. Repeat it to make a retry safe; omit it and every call is a call.
 *     Nothing here parses it (schedule/idempotency.ts)
 *   - it is exactly as exposed as `POST /invoke`: unauthenticated, full tool authority, `http.invoke: false` and a
 *     gateway in front are the answers. The framework authenticates nothing (docs/design/session-control.md §14),
 *     and the previous version's per-occurrence rate ceiling was a bound that looked like a security property
 *     while `/invoke` sat open on the same port
 *
 * NAME IN THE BODY, not the path. A declared name is a filename (`每日简报`, `my schedule` are both legal), and a
 * path segment would mean percent-encoding it — the cost the control plane pays for session ids and this route has
 * no reason to. It also keeps the shape of `POST /invoke`, whose scope rides in the body for the same reason.
 */
import * as Effect from "effect/Effect";
import type { Agent } from "../agent.ts";
import { readBodyCapped, refuseNonJsonBody } from "../channels/body.ts";
import { text } from "../channels/respond.ts";
import { log } from "../log.ts";
import { claimIdempotencyKey } from "./idempotency.ts";
import { type LoadedSchedule, scheduleSession } from "./schedule.ts";
import { runTurn } from "./scheduler.ts";

/** A trigger body is a name and an optional key; the cap only has to admit that. */
const MAX_TRIGGER_BODY_BYTES = 4 * 1024;

/**
 * How much of a caller's `name` a 404 will quote back — the ONE thing this route echoes, because telling a typo
 * from a stale caller needs the name and nothing else does. Long enough to recognise one, short enough not to be a
 * page.
 */
const MAX_ECHOED_NAME = 64;

/** Long enough for a UUID, a delivery id or `<aws.scheduler.scheduled-time>`; short enough not to be a payload. */
const MAX_KEY_LENGTH = 200;

/** The Effect boundary, in one place: the turn runs, and its outcome is what the caller reads. */
const runOnce = (agent: Agent, schedule: LoadedSchedule) =>
  Effect.runPromise(runTurn(agent, schedule.name, scheduleSession(schedule.name), schedule.prompt));

/**
 * Build the handler for `POST /trigger`, bound to what this serve loaded.
 *
 * `undefined` when the definition declares nothing runnable: a route that can only ever answer 404 is not a route,
 * and the startup report names what is actually mounted.
 */
export function createTriggerHandler(options: {
  agent: Agent;
  stateRoot: string;
  schedules: readonly LoadedSchedule[];
}): ((req: Request) => Promise<Response>) | undefined {
  const { agent, stateRoot, schedules } = options;
  if (schedules.length === 0) return undefined;

  return async (req) => {
    if (req.method !== "POST") return text("POST only\n", 405);
    const wrongType = refuseNonJsonBody(req);
    if (wrongType) return wrongType;
    const body = await readBodyCapped(req, MAX_TRIGGER_BODY_BYTES);
    if ("tooLarge" in body) return text("body too large\n", 413);

    let payload: unknown;
    try {
      payload = JSON.parse(body.text);
    } catch {
      return text("invalid json\n", 400);
    }
    const { name, idempotencyKey } = (payload ?? {}) as { name?: unknown; idempotencyKey?: unknown };
    if (typeof name !== "string" || name === "") {
      return text('need { "name": string, "idempotencyKey"?: string } — e.g. {"name":"daily"}\n', 400);
    }
    const schedule = schedules.find((s) => s.name === name);
    // Drift: a caller outliving the thing it calls. The names are listed so an operator can see whether it is a
    // typo or a stale job without shelling in.
    if (!schedule) {
      return text(
        // The name is CLIPPED before it goes back out — the one thing this route echoes. Listing this deployment's
        // own names is deliberate; quoting an unauthenticated caller's 4 KiB of body is not (`refuseNonJsonBody`
        // states the same rule for the same table).
        `no declared work named "${name.slice(0, MAX_ECHOED_NAME)}" (this deployment has: ${schedules
          .map((s) => s.name)
          .join(", ")})\n`,
        404,
      );
    }
    // CAPPED, not parsed. A length is the only property of an opaque token this route has an opinion about, and
    // without one the key is a way to write 4 KiB of caller bytes into this container's state per call.
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)) {
      return text('"idempotencyKey" must be a non-empty string\n', 400);
    }
    if (typeof idempotencyKey === "string" && idempotencyKey.length > MAX_KEY_LENGTH) {
      return text(`"idempotencyKey" is longer than ${MAX_KEY_LENGTH} characters\n`, 400);
    }

    if (typeof idempotencyKey === "string") {
      let first: boolean;
      try {
        first = claimIdempotencyKey(stateRoot, name, idempotencyKey);
      } catch (cause) {
        // The key could not be RECORDED (EACCES, ENOSPC, a broken state root). Running anyway would turn the
        // caller's next retry into a second turn, which is the one thing the key was sent to prevent — so nothing
        // runs and the caller retries. The cause goes to the log alone: it carries absolute paths inside this
        // container and the caller is unauthenticated.
        log.error(`[trigger] recording the idempotency key for "${name}" failed: ${String(cause)}`);
        return text(`"${name}": could not record the idempotency key, nothing ran — retry\n`, 500);
      }
      if (!first) {
        return Response.json({ name, ran: false, reason: "this idempotencyKey already ran", ms: 0 });
      }
    }

    const outcome = await runOnce(agent, schedule);
    return Response.json({ name, ran: true, ...outcome });
  };
}
