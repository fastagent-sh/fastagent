/**
 * Wake ALARMS for the AgentCore deployment: the piece that makes the agent's self-scheduled wake-ups (`wake`) reliable
 * on a host with NO resident process.
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
const SYNC_TIMEOUT_MS = 10_000;
/** Alarms due within this margin are NOT mirrored. */
const DUE_MARGIN_MS = 5_000;

/** Pending wake-ups → the desired alarm set, minus already-due entries (see {@link DUE_MARGIN_MS}). */
export function toAlarms(pending: Wakeup[], now: Date): WakeAlarm[] {
  return pending
    .filter((w) => Date.parse(w.fireAt) > now.getTime() + DUE_MARGIN_MS)
    .map((w) => ({ id: w.id, at: w.fireAt }));
}

/**
 * Build the wakeups sink for an AgentCore deployment (registered via `setWakeupsSink` by `start` when
 * `FASTAGENT_AGENTCORE=1` + `FASTAGENT_WAKE_SECRET` are present).
 */
export function createWakeAlarmSink(options: {
  secret: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => Date;
  /** Injectable retry pause (tests); defaults to exponential-ish backoff off RETRY_BASE_MS. */
  delay?: (ms: number) => Promise<void>;
}): Effect.Effect<(stateRoot: string) => void> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const fork = Effect.runForkWith(yield* Effect.context<never>());
    const { secret, fetchImpl = fetch, now = () => new Date(clock.currentTimeMillisUnsafe()), delay: pause } = options;
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
        if (failures >= MAX_SYNC_ATTEMPTS) {
          log.error(
            `[schedule] wake alarm sync FAILED after ${MAX_SYNC_ATTEMPTS} attempts — pending wake-ups have no ` +
              `external alarm until the next store change or boot re-mirrors them`,
          );
        }
      });

    // Single-flight: a save arriving while the loop runs only marks it dirty, so a burst coalesces into one more pass
    // instead of one concurrent loop each.
    return (stateRoot) => {
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
                  // Store/clock faults cannot be repaired by another POST. A new mutation may retry the mirror.
                  log.error(
                    `[schedule] wake alarm reconcile failed (alarms are stale until the next store change): ${String(portError(cause))}`,
                  );
                }),
              ),
            ),
          (done) =>
            Effect.sync(() => {
              running = false;
              done();
            }),
        ),
      );
    };
  });
}
