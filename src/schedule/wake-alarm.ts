/**
 * ALARMS for the AgentCore deployment: what makes the agent's self-scheduled wake-ups (`wake`) and its schedules fire
 * on a host with NO resident process. The container mirrors both through the forwarder into EventBridge Scheduler:
 * - each schedule as a RECURRING cron schedule, which EventBridge fires on its own clock, the way AWS runs any
 *   recurring job. Mirroring only creates, changes or deletes it; nothing has to happen after a fire for the next
 *   one, so a failed mirror delays an edit, never stops a schedule. Because the container sets it, a schedule written
 *   or edited while it runs takes effect without a deploy.
 * - each pending wake-up as a one-shot schedule that deletes itself once it has poked the container.
 */
import { readFileSync } from "node:fs";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { PortFailure, portError, portJoin, portRequest } from "../effect-port.ts";
import {
  type RecurringSchedule,
  RESERVED_PATHS,
  type WakeAlarm,
  type WakeAlarmRequest,
} from "../channels/agentcore-protocol.ts";
import { beginWork } from "../channels/busy.ts";
import { log } from "../log.ts";
import { scheduleFile, writeScheduleFile } from "./state.ts";
import { type Wakeup, listWakeups } from "./wakeups.ts";
import { toEventBridgeCron } from "./eventbridge-cron.ts";
import type { Schedule } from "./schedule.ts";

const URL_FILE = "wake-alarm-url";

/**
 * Persist the forwarder URL the adapter saw in an envelope (write-if-changed — envelopes arrive on every turn, the
 * file should not churn).
 */
export function rememberWakeAlarmUrl(stateRoot: string, url: string): void {
  if (readWakeAlarmUrl(stateRoot) === url) return;
  writeScheduleFile(scheduleFile(stateRoot, URL_FILE), { url });
}

/** The persisted forwarder URL, or undefined before the first envelope ever seen. */
export function readWakeAlarmUrl(stateRoot: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(scheduleFile(stateRoot, URL_FILE), "utf8")) as { url?: unknown };
    if (typeof v?.url !== "string" || v.url === "") throw new Error("expected a nonempty url string");
    return v.url;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`wake-alarm URL ${scheduleFile(stateRoot, URL_FILE)} is unreadable: ${String(cause)}`, { cause });
  }
}

/**
 * How many times one alarm sync is retried before giving up (each store mutation and every boot restart the cycle, and
 * the pending store is the durable desired state — so "give up" means "until the next mirror", never "lost").
 */
export const MAX_SYNC_ATTEMPTS = 5;
const RETRY_BASE_MS = 2_000;
/**
 * After a whole sync gives up, how long until it is tried again, for as long as this process lives. Outside the busy
 * count, so a container that is only waiting to retry can still be reclaimed; its next start mirrors again.
 */
export const HEAL_MS = 5 * 60_000;
const SYNC_TIMEOUT_MS = 10_000;
/** Alarms due within this margin are NOT mirrored. */
const DUE_MARGIN_MS = 5_000;

/**
 * Pending wake-ups → the desired one-shot alarms. A wake-up already due is left out (see {@link DUE_MARGIN_MS}): the
 * container is awake for it, and its wake pump fires it.
 *
 * ONE ID PER INSTANT, never per wake-up. An alarm deletes itself once it has fired, and a recurring wake-up's claim
 * mirrors its next instant right after: an id reused for it would update the alarm EventBridge is about to delete,
 * and the next instant would be deleted with it. With one id per instant, mirroring again is idempotent.
 */
export function toAlarms(pending: Wakeup[], now: Date): WakeAlarm[] {
  const earliest = now.getTime() + DUE_MARGIN_MS;
  return pending
    .filter((w) => Date.parse(w.fireAt) > earliest)
    .map((w) => ({ id: `${w.id}@${w.fireAt}`, at: w.fireAt }));
}

/**
 * Each armed schedule → the recurring EventBridge schedule that fires it. Discovery admits only a cron that
 * translates (schedule/discover.ts), so one that does not here is a defect, and throws.
 */
export function toRecurring(schedules: readonly Schedule[]): RecurringSchedule[] {
  return schedules.map((s) => {
    const translated = toEventBridgeCron(s.cron);
    if ("error" in translated) throw new Error(`schedule "${s.name}" has no EventBridge form: ${translated.error}`);
    return { name: s.name, expression: translated.expression, tz: s.tz ?? "UTC" };
  });
}

/**
 * Build the wakeups sink for an AgentCore deployment (registered via `setWakeupsSink` by `start` when
 * `FASTAGENT_AGENTCORE=1` + `FASTAGENT_WAKE_SECRET` are present).
 */
export function createWakeAlarmSink(options: {
  secret: string;
  /** The schedules armed now, mirrored as recurring schedules beside the wake-ups' alarms. */
  schedules?: () => readonly Schedule[];
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => Date;
  /** Injectable retry pause (tests); defaults to exponential-ish backoff off RETRY_BASE_MS. */
  delay?: (ms: number) => Promise<void>;
}): Effect.Effect<(stateRoot: string) => void> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const fork = Effect.runForkWith(yield* Effect.context<never>());
    const {
      secret,
      schedules = () => [],
      fetchImpl = fetch,
      now = () => new Date(clock.currentTimeMillisUnsafe()),
      delay: pause,
    } = options;
    const delay = (ms: number) => (pause ? portJoin(() => pause(ms)) : Effect.sleep(ms));
    let running = false;
    let dirty = false;

    /** One POST of the CURRENT desired set. */
    const attemptOnce = (stateRoot: string, attempt: number) =>
      Effect.gen(function* () {
        const alarms = yield* Effect.try({
          try: () => toAlarms(listWakeups(stateRoot), now()),
          catch: (cause) => new PortFailure(cause),
        });
        const recurring = toRecurring(schedules());
        const url = yield* Effect.try({
          try: () => readWakeAlarmUrl(stateRoot),
          catch: (cause) => new PortFailure(cause),
        });
        if (!url) {
          // Nothing to set, before the forwarder was ever seen: nothing can be pending there either.
          if (alarms.length > 0 || recurring.length > 0) {
            log.warn("[schedule] alarm sync skipped — forwarder URL not seen yet");
          }
          return true;
        }
        // Sent EMPTY too: the schedules are the whole set, and the forwarder deletes one this set no longer has.
        const body: WakeAlarmRequest = { secret, alarms, schedules: recurring };
        return yield* portRequest(async (signal) => {
          const res = await fetchImpl(`${url.replace(/\/$/, "")}${RESERVED_PATHS.wakeAlarm}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
          });
          return res;
        }, SYNC_TIMEOUT_MS).pipe(
          Effect.match({
            onSuccess: (res) => {
              if (res.ok) return true;
              log.warn(`[schedule] wake alarm sync attempt ${attempt}/${MAX_SYNC_ATTEMPTS} failed: HTTP ${res.status}`);
              return false;
            },
            onFailure: (error) => {
              log.warn(
                `[schedule] wake alarm sync attempt ${attempt}/${MAX_SYNC_ATTEMPTS} failed: ${String(error.cause)}`,
              );
              return false;
            },
          }),
        );
      });

    const reconcile = (stateRoot: string) =>
      Effect.gen(function* () {
        // Consecutive failures ACROSS passes, not within one.
        let failures = 0;
        while (dirty && failures < MAX_SYNC_ATTEMPTS) {
          dirty = false;
          for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
            if (yield* attemptOnce(stateRoot, attempt)) {
              failures = 0;
              break;
            }
            failures++;
            if (attempt === MAX_SYNC_ATTEMPTS || failures >= MAX_SYNC_ATTEMPTS) break;
            yield* delay(RETRY_BASE_MS * attempt);
            // A mutation landed mid-retry: the desired state moved, so this budget is spent on a set that no longer
            // exists.
            if (dirty) break;
          }
        }
        if (failures < MAX_SYNC_ATTEMPTS) return true;
        log.error(
          `[schedule] alarm sync FAILED after ${MAX_SYNC_ATTEMPTS} attempts — new wake-ups have no alarm, and ` +
            `schedule edits since the last sync have not reached EventBridge (schedules it already holds keep ` +
            `firing). It is tried again every ${HEAL_MS / 60_000} minutes while this container runs, and at its next start`,
        );
        return false;
      });

    /** One retry pending at a time, however many syncs gave up meanwhile. */
    let healing = false;
    // Single-flight: a save arriving while the loop runs only marks it dirty, so a burst coalesces into one more pass
    // instead of one concurrent loop each.
    const sink = (stateRoot: string): void => {
      dirty = true;
      if (running) return;
      running = true;
      fork(
        Effect.acquireUseRelease(
          Effect.sync(beginWork),
          () =>
            // Claim notification precedes scheduler admission; retain busy ownership through that handoff.
            Effect.yieldNow.pipe(
              Effect.andThen(reconcile(stateRoot)),
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  log.error(
                    `[schedule] alarm reconcile failed (tried again in ${HEAL_MS / 60_000} minutes while this ` +
                      `container runs): ${String(portError(cause))}`,
                  );
                  return false;
                }),
              ),
            ),
          (done) =>
            Effect.sync(() => {
              running = false;
              done();
            }),
        ).pipe(
          Effect.flatMap((converged) =>
            converged || healing
              ? Effect.void
              : Effect.sync(() => {
                  healing = true;
                }).pipe(
                  Effect.andThen(delay(HEAL_MS)),
                  Effect.andThen(
                    Effect.sync(() => {
                      healing = false;
                      sink(stateRoot);
                    }),
                  ),
                ),
          ),
        ),
      );
    };
    return sink;
  });
}
