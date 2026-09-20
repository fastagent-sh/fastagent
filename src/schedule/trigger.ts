/**
 * `POST /trigger` — the EXTERNAL form of a time trigger: someone else's clock says an occurrence arrived, this
 * process runs the schedule the definition wrote down for it.
 *
 * THE DIVISION OF LABOUR, which is the whole design and is the industry's:
 *
 *   the CLOCK owns  — the grid (deploy projects the definition's cron into it), LIVENESS (retry until 200), and
 *                     NAMING the occurrence, because only it knows which of its attempts are retries of one fire
 *   this route owns — running the turn AT MOST ONCE per name, refusing what is too late to be worth running, and
 *                     reporting which of those happened
 *
 * Composed: exactly once per occurrence, for as long as the clock delivers at least once. That is the standard
 * at-least-once + idempotent-receiver shape, and every scheduler that solves this solves it this way — EventBridge
 * Scheduler hands the target `<aws.scheduler.scheduled-time>`, Cloudflare hands `scheduled()` its
 * `controller.scheduledTime`, and both tell you to dedupe on it.
 *
 * WHY THE RECEIVER DOES NOT RECOMPUTE THE OCCURRENCE. It was tried: snap this machine's clock to the schedule's
 * grid and use that. It is wrong, and measurably so — EventBridge's redelivery backoff was measured at +60s and
 * +186s after the first attempt (a real schedule, ap-southeast-1), which for any schedule with a period under
 * about five minutes lands in a LATER occurrence than the one being retried. Snapping would have given that retry
 * a different name and run the turn a second time, which is the exact duplicate this route exists to prevent. A
 * retry is a retry because the CLOCK says so; nothing this process can measure will tell it.
 *
 * WHY THE PROMPT IS NOT ON THE WIRE. A caller could already drive a turn through `POST /invoke`; what this route
 * adds is that the turn's content stays in `schedules/<name>.ts`. Carrying the prompt here instead would move the
 * agent's behaviour out of the definition and into someone's crontab line, which is the one thing the definition is
 * for. So the body is a REFERENCE plus the clock's name for this fire, and nothing else.
 *
 * NAME IN THE BODY, not the path. A schedule name is a filename (`每日简报`, `my schedule` are both legal), and a
 * path segment would mean percent-encoding it — the cost the control plane pays for session ids and this route has
 * no reason to. It also keeps the shape of `POST /invoke`, whose scope rides in the body for the same reason.
 *
 * ONE SEMANTIC, ONE IMPLEMENTATION: the fire itself is `fireScheduleOnce`, the same claim/run/settle the resident
 * cron loop uses. `claimSlot` is an `O_EXCL` create, so several clocks over one state root take the same name and
 * exactly one of them runs it (schedule/state.ts).
 */
import * as Effect from "effect/Effect";
import type { Agent } from "../agent.ts";
import { readBodyCapped, refuseNonJsonBody } from "../channels/body.ts";
import { text } from "../channels/respond.ts";
import { log } from "../log.ts";
import { nextRun } from "./cron.ts";
import type { LoadedSchedule } from "./schedule.ts";
import { fireScheduleOnce } from "./scheduler.ts";
import { latestFire } from "./state.ts";

/** The Effect boundary, in one place: a `PortFailure` becomes the rejection the handler translates. */
const runFire = (agent: Agent, stateRoot: string, schedule: LoadedSchedule, slot: Date) =>
  Effect.runPromise(fireScheduleOnce({ agent, stateRoot, schedule, slot }).pipe(Effect.mapError((e) => e.cause)));

/** A trigger body is a name and an occurrence; the cap only has to admit that. */
const MAX_TRIGGER_BODY_BYTES = 4 * 1024;

/**
 * How much of a caller's `name` a 404 will quote back — the ONE thing this route echoes, because telling a typo
 * from a stale clock rule needs the name and nothing else does. Long enough to recognise one, short enough not to
 * be a page.
 */
const MAX_ECHOED_NAME = 64;

/**
 * The first occurrence STRICTLY AFTER the last one this schedule fired — the bar a delivery must clear to be a
 * different fire rather than another name for the same one.
 *
 * THIS IS THE RATE CEILING, and without it the route had none. `claimSlot` refuses only a name it already holds or
 * one older than its newest, so an unauthenticated caller naming `occurrence` could walk it forward a millisecond
 * at a time and buy a full model turn per request: 20 requests to a `0 9 * * *` schedule ran 20 turns. The route is
 * anonymous, and the posture this feature recommends (`http.invoke: false` + `http.trigger: true`) makes it the
 * ONLY anonymous way to start one.
 *
 * ONE STEP FORWARD ON THE GRID, not a duration, because that is what "a different occurrence" means and it stays
 * right for a cron whose occurrences are not evenly spaced (`0 9 * * 1-5`: Friday's next is Monday, Monday's is
 * Tuesday). The receiver still does not compute WHICH occurrence a delivery is for — the clock names that. It only
 * asks whether the name it was given could be a new one.
 *
 * Cached per schedule against the claim it was computed from, so a flood that the ceiling refuses costs no cron
 * evaluation at all.
 */
function nextAfterFactory(): (schedule: LoadedSchedule, newest: Date) => Date | undefined {
  const cache = new Map<string, { after: number; next: Date | undefined }>();
  return (schedule, newest) => {
    const cached = cache.get(schedule.name);
    if (cached && cached.after === newest.getTime()) return cached.next;
    const next = nextRun(schedule.cron, schedule.tz, newest);
    cache.set(schedule.name, { after: newest.getTime(), next });
    return next;
  };
}

/**
 * The ONE answer to "this container could not read or write its own claim state".
 *
 * Both readings of that state — the newest claim, and the `O_EXCL` create — fail the same way and BEFORE any claim
 * exists, so the occurrence is unburned and the clock's retry is the right answer. Translated rather than thrown so
 * the message reaches the external clock's own log, which is where a cron box's operator looks; the router's
 * boundary would answer a bare `internal error`.
 *
 * The CAUSE goes to the log and only there: it is an fs error carrying absolute paths inside this container, and
 * the caller is unauthenticated (the rule `refuseNonJsonBody` follows by not echoing what arrived).
 */
function claimStateUnavailable(name: string, at: Date, cause: unknown): Response {
  log.error(`[schedule] firing schedule "${name}" for ${at.toISOString()} failed: ${String(cause)}`);
  return text(`schedule "${name}": claim state unavailable, nothing was claimed — retry\n`, 500);
}

/**
 * Build the handler for `POST /trigger`, bound to the schedules this serve loaded.
 *
 * `undefined` when the definition declares none: a route that can only ever answer 404 is not a route, and the
 * startup report names what is actually mounted.
 */
export function createTriggerHandler(options: {
  agent: Agent;
  stateRoot: string;
  schedules: readonly LoadedSchedule[];
}): ((req: Request) => Promise<Response>) | undefined {
  const { agent, stateRoot, schedules } = options;
  if (schedules.length === 0) return undefined;
  const nextAfter = nextAfterFactory();

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
    const { name, occurrence } = (payload ?? {}) as { name?: unknown; occurrence?: unknown };
    if (typeof name !== "string" || name === "") {
      return text('need { "name": string, "occurrence"?: ISO-date } — e.g. {"name":"daily"}\n', 400);
    }
    const schedule = schedules.find((s) => s.name === name);
    // Deploy drift: an external clock rule outliving the schedule it fires for. The names are listed so the operator
    // can see whether it is a typo or a stale rule without shelling in.
    if (!schedule) {
      return text(
        // The name is CLIPPED before it goes back out — the one thing this route echoes. Listing this deployment's
        // own schedules is deliberate; quoting an unauthenticated caller's 4 KiB of body is not (`refuseNonJsonBody`
        // states the same rule for the same table).
        `no schedule named "${name.slice(0, MAX_ECHOED_NAME)}" (this deployment has: ${schedules
          .map((s) => s.name)
          .join(", ")})\n`,
        404,
      );
    }
    if (occurrence !== undefined && (typeof occurrence !== "string" || Number.isNaN(Date.parse(occurrence)))) {
      return text('"occurrence" must be an ISO date — the instant YOUR clock scheduled this fire for\n', 400);
    }

    const now = new Date();
    // AN UNNAMED DELIVERY still works: a crontab's `curl` has nothing to name, so this delivery IS its own
    // occurrence. What keeps that from being a blank cheque is the ceiling below, which an unnamed caller meets on
    // its second request just as a named one does — the route never has to guess which grid point was meant.
    const at = typeof occurrence === "string" ? new Date(occurrence) : now;

    // AHEAD OF THIS CLOCK is refused rather than run. It is not a defence against skew — it is that an occurrence
    // which has not arrived cannot have been delivered, so the caller and this container disagree about the time
    // and only one of them can be believed here. Refusing is self-healing BECAUSE the name is the clock's: the
    // retry carries the same one (measured), by which time this clock has moved.
    if (at.getTime() > now.getTime()) {
      return text(
        // The caller's string is not quoted back. `Date.parse` is V8's lenient parser (`Dec 25 2999 (${"A"
        // .repeat(3000)})` parses), so echoing it would reflect most of MAX_TRIGGER_BODY_BYTES to an
        // unauthenticated caller. Our clock is the half of the comparison it does not have.
        `"occurrence" is ahead of this machine's clock (now ${now.toISOString()}) — an occurrence that has not ` +
          `arrived cannot have been delivered. Retry\n`,
        400,
      );
    }

    // THE CEILING, and it runs FIRST because it is the cheap one: a name between the last fire and the next
    // occurrence after it cannot be a new fire, whatever instant it carries. `at` at or before the newest claim
    // falls through instead — `claimSlot` tells a redelivery (`duplicate`) from a clock that moved backwards
    // (`stale`) precisely, and those readings are worth keeping.
    let newest: string | undefined;
    try {
      newest = latestFire(stateRoot, name)?.slot;
    } catch (cause) {
      // The claims directory could not be READ (EACCES, ENOTDIR on a broken state root). Nothing was claimed, so
      // the occurrence is unburned and the clock's retry is the right answer — the same fault, and the same
      // answer, as the fire below.
      return claimStateUnavailable(name, at, cause);
    }
    if (newest !== undefined && at.getTime() > Date.parse(newest)) {
      const bar = nextAfter(schedule, new Date(newest));
      if (bar === undefined || at.getTime() < bar.getTime()) {
        return Response.json({
          slot: at.toISOString(),
          fired: false,
          skippedReason:
            `${at.toISOString()} is not a new occurrence of "${name}": this schedule last fired ${newest} and its ` +
            `next occurrence is ${bar?.toISOString() ?? "never"}, so nothing between them is a fire of its own`,
          ms: 0,
        });
      }
    }

    // SUPERSEDED, which is what "too stale to run" means exactly: the occurrence AFTER this one has already
    // arrived. Measured from `at` on the grid, so it is right for a cron whose gaps differ — Friday's occurrence of
    // `0 9 * * 1-5` owns three days, Monday's owns one — where any single duration would be wrong for one of them.
    //
    // Only for a delivery that could actually claim. At or before the newest claim it cannot: `claimSlot` will read
    // it as a duplicate or a stale replay either way, and a redelivery is the commonest repeat there is — it should
    // not pay for a cron evaluation to be told what the claim file already says.
    if (newest === undefined || at.getTime() > Date.parse(newest)) {
      const supersededBy = nextRun(schedule.cron, schedule.tz, at);
      if (supersededBy === undefined) {
        return text(`schedule "${name}" (cron "${schedule.cron}") has no further occurrences\n`, 409);
      }
      // A 200 rather than an error: the delivery SUCCEEDED, the occurrence is simply not worth running any more,
      // and a clock that kept retrying a 4xx would hammer this route over a turn nobody wants. It is what a
      // scheduled AGENT TURN needs — "summarise today" six hours late is a wrong digest, not a late one, which is
      // the same reason Kubernetes has `startingDeadlineSeconds`.
      if (supersededBy.getTime() <= now.getTime()) {
        return Response.json({
          slot: at.toISOString(),
          fired: false,
          skippedReason:
            `occurrence ${at.toISOString()} was superseded at ${supersededBy.toISOString()} — a turn this stale ` +
            `would produce the wrong answer, so the next occurrence is the one to wait for`,
          ms: 0,
        });
      }
    }

    // THE boundary. `fireScheduleOnce`'s only failure is a claim-state fault — the slot could not be read or
    // created — which happens BEFORE any claim exists, so the occurrence is still unburned and the caller's retry
    // is the right answer. It is translated rather than thrown so the message reaches the external clock's own log,
    // which is where a cron box's operator looks; the router's boundary would answer a bare `internal error`.
    let outcome: Awaited<ReturnType<typeof runFire>>;
    try {
      outcome = await runFire(agent, stateRoot, schedule, at);
    } catch (cause) {
      return claimStateUnavailable(name, at, cause);
    }
    return Response.json({ slot: at.toISOString(), ...outcome });
  };
}
