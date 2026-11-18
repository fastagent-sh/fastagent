/**
 * Keeps an external platform alarm (such as an AgentCore session's EventBridge schedule) converged to when this
 * instance next needs a running process: the earliest of its clock's next cron or wake-up, pi-durable's own earliest
 * task sleep (`harness.wake().at`), and, once a run has been active past {@link ACTIVE_DEBOUNCE_MS}, a recovery
 * heartbeat ({@link ACTIVE_RECOVERY_MS}) so a machine killed mid-run or at its lifetime cap is woken to `resume()`.
 *
 * Every `setAlarm` runs inside `beginWork()`, so `/ping` stays `HealthyBusy` until the platform confirms the new time.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitPublication, Harness } from "@earendil-works/pi-durable";
import { activeWork, beginWork } from "../../busy.ts";
import { log } from "../../log.ts";
import { CLOCK_DOC_KINDS } from "./clock.ts";

/** Short turns finish before any recovery alarm is written, so ordinary chat makes zero alarm calls. */
const ACTIVE_DEBOUNCE_MS = 10_000;
/** If a machine dies mid-run, wake a replacement within 5 minutes so `harness.resume()` finishes the durable turn. */
const ACTIVE_RECOVERY_MS = 5 * 60_000;

export interface InstanceAlarmOptions {
  harness: Harness;
  nextClockDue: (now: Date) => Promise<Date | undefined>;
  setAlarm: (at: Date | undefined) => void | Promise<void>;
  now?: () => Date;
  activeDebounceMs?: number;
  activeRecoveryMs?: number;
}

export interface InstanceAlarm {
  /** Converge the external alarm now. `forceClear` disarms even when this process never armed one (an alarm's `tick`). */
  sync(options?: { forceClear?: boolean }): Promise<void>;
  stop(): void;
}

function relevantCommit(publication: CommitPublication): boolean {
  return publication.changes.some(
    (change) =>
      change.type === "task" ||
      change.type === "submission" ||
      (change.type === "document" && CLOCK_DOC_KINDS.has(change.record.kind)),
  );
}

export function watchInstanceAlarm(options: InstanceAlarmOptions): InstanceAlarm {
  const {
    harness,
    nextClockDue,
    setAlarm,
    now = () => new Date(),
    activeDebounceMs = ACTIVE_DEBOUNCE_MS,
    activeRecoveryMs = ACTIVE_RECOVERY_MS,
  } = options;
  let closed = false;
  let dirty = false;
  let forceClear = false;
  let everArmed = false;
  let includeHeartbeat = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let waitingIdle = false;
  let ownBusy = 0;
  let inFlight: Promise<void> | undefined;

  const isWorkActive = (): boolean => harness.wake().active || activeWork() > ownBusy;

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    includeHeartbeat = false;
  };

  const trackActive = (): void => {
    if (closed) return;
    if (!isWorkActive()) {
      clearHeartbeat();
      return;
    }
    if (!waitingIdle) {
      waitingIdle = true;
      harness.waitForIdle(BACKGROUND_CONTEXT).then(
        () => {
          waitingIdle = false;
          clearHeartbeat();
          scheduleBackground();
        },
        () => {
          waitingIdle = false;
        },
      );
    }
    if (!includeHeartbeat && heartbeatTimer === undefined) {
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = undefined;
        if (closed || !isWorkActive()) return;
        includeHeartbeat = true;
        scheduleBackground();
      }, activeDebounceMs);
      heartbeatTimer.unref?.();
    }
  };

  const runLoop = async (): Promise<void> => {
    ownBusy += 1;
    const done = beginWork();
    try {
      while (dirty && !closed) {
        dirty = false;
        const clear = forceClear;
        forceClear = false;
        const current = now();
        const clockAt = await nextClockDue(current);
        if (closed) return;
        trackActive();
        const wake = harness.wake();
        const active = isWorkActive();
        let earliest: number | undefined;
        const consider = (ms: number | undefined) => {
          if (ms !== undefined && (earliest === undefined || ms < earliest)) earliest = ms;
        };
        consider(clockAt?.getTime());
        consider(wake.at);
        if (active && includeHeartbeat) consider(current.getTime() + activeRecoveryMs);
        if (earliest === undefined && !everArmed && !clear) continue;
        await setAlarm(earliest === undefined ? undefined : new Date(earliest));
        everArmed = earliest !== undefined;
      }
    } finally {
      ownBusy -= 1;
      done();
    }
  };

  const sync = (syncOptions?: { forceClear?: boolean }): Promise<void> => {
    if (closed) return Promise.resolve();
    dirty = true;
    if (syncOptions?.forceClear) forceClear = true;
    inFlight ??= runLoop().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const scheduleBackground = (): void => {
    if (closed) return;
    sync().catch((error: unknown) => log.error(`[fastagent] setting the instance's alarm failed: ${String(error)}`));
  };

  const commits = harness.observeCommits({
    advance(publication) {
      if (relevantCommit(publication)) scheduleBackground();
    },
    end() {
      clearHeartbeat();
    },
  });

  return {
    sync,
    stop() {
      closed = true;
      clearHeartbeat();
      commits.detach();
    },
  };
}
