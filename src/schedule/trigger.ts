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
 * ONE SEMANTIC, ONE IMPLEMENTATION: the fire itself is `fireScheduleOnce`, the same claim/run/settle the resident
 * cron loop uses. Two clocks over one state root is safe by construction — `claimSlot` is an `O_EXCL` create, so the
 * slot is taken by exactly one of them (schedule/state.ts).
 */
import * as Effect from "effect/Effect";
import type { Agent } from "../agent.ts";
import { readBodyCapped, refuseNonJsonBody } from "../channels/body.ts";
import { text } from "../channels/respond.ts";
import { log } from "../log.ts";
import { previousRun } from "./cron.ts";
import type { LoadedSchedule } from "./schedule.ts";
import { fireScheduleOnce } from "./scheduler.ts";

/** The Effect boundary, in one place: a `PortFailure` becomes the rejection the handler translates. */
const runFire = (agent: Agent, stateRoot: string, schedule: LoadedSchedule, slot: Date) =>
  Effect.runPromise(fireScheduleOnce({ agent, stateRoot, schedule, slot }).pipe(Effect.mapError((e) => e.cause)));

/** A trigger body is a name and an optional instant; the cap only has to admit that. */
const MAX_TRIGGER_BODY_BYTES = 4 * 1024;

/**
 * Build the handler for `POST /trigger`, bound to the schedules this serve loaded.
 *
 * `undefined` when the definition declares none: a route that can only ever answer 404 is not a route, and its
 * absence is what the startup report and the deploy runbook describe.
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
    const { name, slot } = (payload ?? {}) as { name?: unknown; slot?: unknown };
    if (typeof name !== "string" || name === "") {
      return text('need { "name": string, "slot"?: ISO-date } — e.g. {"name":"daily"}\n', 400);
    }
    const schedule = schedules.find((s) => s.name === name);
    // Deploy drift: an external clock rule outliving the schedule it fires for. The names are listed so the operator
    // can see whether it is a typo or a stale rule without shelling in.
    if (!schedule) {
      return text(
        `no schedule named "${name}" (this deployment has: ${schedules.map((s) => s.name).join(", ")})\n`,
        404,
      );
    }
    if (slot !== undefined && (typeof slot !== "string" || Number.isNaN(Date.parse(slot)))) {
      return text('"slot" must be an ISO date\n', 400);
    }

    // The slot is an IDENTITY, not a timestamp: `claimSlot` keys on it, so two deliveries of the same occurrence
    // must name the same instant or the turn runs twice. A caller that computed the cron grid itself (EventBridge
    // sends `<aws.scheduler.scheduled-time>`) says so; a crontab line that just fires `curl` cannot, so an omitted
    // slot is snapped to the occurrence this schedule most recently had.
    const at = slot === undefined ? previousRun(schedule.cron, schedule.tz, new Date()) : new Date(slot);
    if (at === undefined) {
      return text(`schedule "${name}" (cron "${schedule.cron}") has no occurrence at or before now\n`, 409);
    }

    // THE boundary. `fireScheduleOnce`'s only failure is a claim-state fault — the slot could not be read or
    // created — which happens BEFORE any claim exists, so the occurrence is still unburned and the caller's retry
    // is the right answer. It is translated rather than thrown so the message reaches the external clock's own log,
    // which is where a cron box's operator looks; the router's boundary would answer a bare `internal error`.
    let outcome: Awaited<ReturnType<typeof runFire>>;
    try {
      outcome = await runFire(agent, stateRoot, schedule, at);
    } catch (cause) {
      const detail = `firing schedule "${name}" for slot ${at.toISOString()} failed: ${String(cause)}`;
      log.error(`[schedule] ${detail}`);
      return text(`${detail}\n`, 500);
    }
    return Response.json({ slot: at.toISOString(), ...outcome });
  };
}
