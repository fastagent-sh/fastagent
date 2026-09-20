/**
 * `POST /trigger` — the EXTERNAL form of a time trigger: someone else's clock says an instant arrived, this process
 * runs the schedule the definition wrote down for it.
 *
 * WHY THE PROMPT IS NOT ON THE WIRE. A caller could already drive a turn through `POST /invoke`; what this route
 * adds is that the turn's content stays in `schedules/<name>.ts`. Carrying the prompt here instead would move the
 * agent's behaviour out of the definition and into someone's crontab line, which is the one thing the definition is
 * for. So the body is a REFERENCE plus an idempotency key, and nothing else.
 *
 * NAME IN THE BODY, not the path. A schedule name is a filename (`每日简报`, `my schedule` are both legal), and a
 * path segment would mean percent-encoding it — the cost the control plane pays for session ids and this route has
 * no reason to. It also keeps the shape of `POST /invoke`, whose scope rides in the body for the same reason.
 *
 * AND NO INSTANT ON THE WIRE EITHER — this serve decides which occurrence the delivery is for, by snapping its own
 * clock to the schedule's grid. A caller-named slot was tried and removed: it asks two machines to agree on which
 * moment it is, which is a consistency problem we do not have, to get an idempotency guarantee `claimSlot` already
 * gives by `O_EXCL` alone. What it cost was a defence for every way that number could be wrong — a future instant
 * poisons `claimSlot`'s `wanted < newest` gate forever, an off-grid one mints a claim no occurrence matches, an old
 * on-grid one replays history a turn at a time, and computing the bounds for all three was ~6ms of synchronous
 * croner per request on an anonymous route. Removing the field removed all four: the only instants that now reach
 * `claimSlot` come from the resident loop's `nextRun` or this route's `previousRun(now)`, and both are grid points
 * in the past BY CONSTRUCTION.
 *
 * WHAT IT GIVES UP is a delivery late by more than one period being credited to the occurrence it was sent for: a
 * retry at 10:01 fires 10:01, not the 10:00 it missed. Turn count per occurrence is unchanged, and catch-up was
 * never this route's job — an external clock's redelivery is a fire, not a backfill.
 *
 * ONE SEMANTIC, ONE IMPLEMENTATION: the fire itself is `fireScheduleOnce`, the same claim/run/settle the resident
 * cron loop uses. Two clocks over one state root is safe by construction — `claimSlot` is an `O_EXCL` create, so the
 * slot is taken by exactly one of them (schedule/state.ts).
 */
import * as Effect from "effect/Effect";
import type { Agent } from "../agent.ts";
import { readBodyCapped, refuseNonJsonBody } from "../channels/body.ts";
import { text } from "../channels/respond.ts";
import { log } from "../log.ts";
import { nextRun, previousRun } from "./cron.ts";
import type { LoadedSchedule } from "./schedule.ts";
import { fireScheduleOnce } from "./scheduler.ts";

/** The Effect boundary, in one place: a `PortFailure` becomes the rejection the handler translates. */
const runFire = (agent: Agent, stateRoot: string, schedule: LoadedSchedule, slot: Date) =>
  Effect.runPromise(fireScheduleOnce({ agent, stateRoot, schedule, slot }).pipe(Effect.mapError((e) => e.cause)));

/** A trigger body is a name and an optional instant; the cap only has to admit that. */
const MAX_TRIGGER_BODY_BYTES = 4 * 1024;

/**
 * How much of a caller's `name` a 404 will quote back — the ONE thing this route echoes, because telling a typo
 * from a stale clock rule needs the name and nothing else does. Long enough to recognise one, short enough not to
 * be a page.
 */
const MAX_ECHOED_NAME = 64;

/**
 * The occurrence a delivery arriving NOW is for: this serve's clock, snapped to the schedule's grid.
 *
 * SNAPPED, because the slot is an IDENTITY — `claimSlot` keys on it, so a redelivery must name the same instant as
 * the first attempt or the turn runs twice. `now` itself never repeats; its occurrence does, for as long as the
 * occurrence lasts. It is also what the resident loop claims (`slot: due`, the exact `nextRun` instant), so the two
 * clocks collide on one name and `O_EXCL` settles it.
 *
 * CACHED until the grid moves past it, because this is the only expensive thing the route does: `previousRun` is
 * ~40 synchronous croner evaluations (~6ms measured) on the one thread that also answers every channel webhook,
 * `/control/*` and `/health`, and the route is anonymous. `until` is the next occurrence — exactly when the answer
 * changes. Keyed by schedule name, bounded by the declared schedules.
 */
function occurrenceFactory(): (schedule: LoadedSchedule, now: Date) => Date | undefined {
  const cache = new Map<string, { until: number; at: Date | undefined }>();
  return (schedule, now) => {
    const cached = cache.get(schedule.name);
    if (cached && now.getTime() < cached.until) return cached.at;
    const at = previousRun(schedule.cron, schedule.tz, now);
    cache.set(schedule.name, { until: nextRun(schedule.cron, schedule.tz, now)?.getTime() ?? Infinity, at });
    return at;
  };
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
  const occurrenceFor = occurrenceFactory();

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
    const { name } = (payload ?? {}) as { name?: unknown };
    if (typeof name !== "string" || name === "") {
      return text('need { "name": string } — e.g. {"name":"daily"}\n', 400);
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

    const at = occurrenceFor(schedule, new Date());
    // Armed but not yet due: the definition declares it, the grid has simply not reached its first occurrence. The
    // caller is early rather than wrong, so this says which grid it was measured against.
    if (at === undefined) {
      return text(`schedule "${name}" (cron "${schedule.cron}") has not come due yet\n`, 409);
    }

    // THE boundary. `fireScheduleOnce`'s only failure is a claim-state fault — the slot could not be read or
    // created — which happens BEFORE any claim exists, so the occurrence is still unburned and the caller's retry
    // is the right answer. It is translated rather than thrown so the message reaches the external clock's own log,
    // which is where a cron box's operator looks; the router's boundary would answer a bare `internal error`.
    let outcome: Awaited<ReturnType<typeof runFire>>;
    try {
      outcome = await runFire(agent, stateRoot, schedule, at);
    } catch (cause) {
      // The CAUSE goes to the log and only there: it is an fs error carrying absolute paths inside this container,
      // and the caller is unauthenticated. What an external clock needs from a 500 is "this delivery failed and is
      // worth retrying", which the status and this wording already say — the same rule `refuseNonJsonBody` follows
      // by not echoing what arrived.
      log.error(`[schedule] firing schedule "${name}" for slot ${at.toISOString()} failed: ${String(cause)}`);
      return text(`schedule "${name}": claim state unavailable, nothing was claimed — retry\n`, 500);
    }
    return Response.json({ slot: at.toISOString(), ...outcome });
  };
}
