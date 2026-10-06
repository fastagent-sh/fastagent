/**
 * Wake ALARMS for the AgentCore deployment: what makes the agent's self-scheduled wake-ups (`wake`) and its schedules
 * fire on a host with NO resident process. Each is mirrored into a one-shot EventBridge schedule the forwarder sets;
 * a schedule's alarm carries the instant it is for, and after each fire the next one is mirrored. Because the
 * container sets them, a schedule written or edited while it runs gets its alarm without a deploy.
 */
import { readFileSync } from "node:fs";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { PortFailure, portError, portJoin, portRequest } from "../effect-port.ts";
import { RESERVED_PATHS, type WakeAlarm, type WakeAlarmRequest } from "../channels/agentcore-protocol.ts";
import { beginWork } from "../channels/busy.ts";
import { log } from "../log.ts";
import { scheduleFile, writeScheduleFile } from "./state.ts";
import { type Wakeup, listWakeups } from "./wakeups.ts";
import { nextRun } from "./cron.ts";
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
 * How long after every sync, however it ended, the whole set is mirrored again, for as long as this process lives. An
 * alarm can be lost in ways no sync sees (a sync that gave up, a schedule deleted by hand), and with no timer of its
 * own in the container a lost schedule alarm is a schedule that has stopped; mirroring again is idempotent (one id per
 * instant). Outside the busy count, so a container that is only waiting for it can still be reclaimed; its next start
 * mirrors again.
 */
export const HEAL_MS = 5 * 60_000;
const SYNC_TIMEOUT_MS = 10_000;
/** Alarms due within this margin are NOT mirrored. */
const DUE_MARGIN_MS = 5_000;

/**
 * Pending wake-ups and each schedule's next instant → the desired alarm set. A wake-up already due is left out (see
 * {@link DUE_MARGIN_MS}): the container is awake for it, and its wake pump fires it. A schedule's alarm is the ONLY
 * thing that fires its instant (the container runs no timer of its own there), so one too near to set is set just
 * past the margin, still naming its instant.
 *
 * ONE ID PER INSTANT, never per schedule or wake-up. An alarm deletes itself once it has fired, and mirroring runs right
 * after a fire: an id reused for the next instant would update the alarm EventBridge is about to delete, and the next
 * instant would be deleted with it. With one id per instant, mirroring again is idempotent, and an alarm that outlived
 * an edit fires once and is answered as skipped (a schedule) or finds nothing due (a wake-up).
 */
export function toAlarms(pending: Wakeup[], schedules: readonly Schedule[], now: Date): WakeAlarm[] {
  const earliest = now.getTime() + DUE_MARGIN_MS;
  return [
    ...pending.filter((w) => Date.parse(w.fireAt) > earliest).map((w) => ({ id: `${w.id}@${w.fireAt}`, at: w.fireAt })),
    ...schedules.flatMap((s) => {
      const next = nextRun(s.cron, s.tz, now);
      if (!next) return [];
      const occurrence = next.toISOString();
      const at = next.getTime() > earliest ? occurrence : new Date(earliest + 1000).toISOString();
      return [{ id: `schedule:${s.name}@${occurrence}`, at, fire: { name: s.name, occurrence } }];
    }),
  ];
}

/**
 * Build the wakeups sink for an AgentCore deployment (registered via `setWakeupsSink` by `start` when
 * `FASTAGENT_AGENTCORE=1` + `FASTAGENT_WAKE_SECRET` are present).
 */
export function createWakeAlarmSink(options: {
  secret: string;
  /** The schedules armed now, whose next instants are mirrored with the wake-ups. */
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
          try: () => toAlarms(listWakeups(stateRoot), schedules(), now()),
          catch: (cause) => new PortFailure(cause),
        });
        // Nothing future to mirror: converged.
        if (alarms.length === 0) return true;
        const url = yield* Effect.try({
          try: () => readWakeAlarmUrl(stateRoot),
          catch: (cause) => new PortFailure(cause),
        });
        if (!url) {
          log.warn("[schedule] wake alarm skipped — forwarder URL not seen yet");
          return true;
        }
        const body: WakeAlarmRequest = { secret, alarms };
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
        if (failures < MAX_SYNC_ATTEMPTS) return;
        log.error(
          `[schedule] alarm sync FAILED after ${MAX_SYNC_ATTEMPTS} attempts — pending wake-ups and the schedules' ` +
            `next instants have no alarm. It is tried again every ${HEAL_MS / 60_000} minutes while this container ` +
            `runs; if the container is reclaimed first, they are set again when something next wakes it, and a ` +
            `deployment with nothing else to wake it sleeps through every instant until then`,
        );
      });

    /** One re-mirror pending at a time, however many syncs ended meanwhile. */
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
                  // Store/clock faults are not retried here; the re-mirror below, or a new mutation, tries again.
                  log.error(
                    `[schedule] alarm reconcile failed (tried again within ${HEAL_MS / 60_000} minutes while this ` +
                      `container runs): ${String(portError(cause))}`,
                  );
                }),
              ),
            ),
          (done) =>
            Effect.sync(() => {
              running = false;
              done();
            }),
        ).pipe(
          Effect.flatMap(() =>
            healing
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
