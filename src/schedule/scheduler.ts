/**
 * The scheduler: a time-trigger that fires the agent on each schedule's cron. SINGLE-PROCESS (like all
 * fastagent state today) — a deployment with schedules must keep one machine running, since cron has no
 * external wake-up (Phase 3 makes `deploy` enforce that). Started/stopped by the serve path (dev/start).
 *
 * Fire model:
 *  - **stable session per schedule** (`schedule:<name>`), so a schedule's turns share one continuing
 *    conversation persisted by the core session store; the scheduler is ZERO-touch on session storage.
 *  - **output is the agent's tools' job** — the scheduler only fires and logs the outcome.
 *  - **durability = catch up ONCE** (`state.ts`): on start, if the next instant after the last fire is
 *    already past (the process was down across it), fire once and advance — not once per missed slot.
 *    lastFired is claimed BEFORE the invoke (at-most-once per slot: a crash mid-turn won't re-fire it;
 *    "a digest late once" beats "twice"). Strict at-least-once (a per-turn WAL) is a later tier.
 */
import type { Agent } from "../agent.ts";
import { log } from "../log.ts";
import { nextRun } from "./cron.ts";
import type { LoadedSchedule } from "./schedule.ts";
import { type Fires, loadFires, saveFires } from "./state.ts";

/** A schedule's turns share this stable session — a continuing conversation, like the telegram channel's
 *  per-chat session. Derived at RUNTIME from the name (never an authored field). */
export function scheduleSession(name: string): string {
  return `schedule:${name}`;
}

export interface Scheduler {
  /** Arm every schedule (catching up an overdue one once). Idempotent-ish: call once per process. */
  start(): void;
  /** Clear all armed timers. Does NOT drain an in-flight fire (SIGTERM exits mid-turn by design; the
   *  interrupted turn is not re-fired — lastFired was already claimed). A catch-up fire in flight has NO
   *  timer entry to clear either (the overdue branch fires directly, without arming), so `stop()` simply
   *  lets it run out or be cut by process exit — same non-drain, and its claim is already persisted. */
  stop(): void;
}

export interface SchedulerOptions {
  agent: Agent;
  stateRoot: string;
  schedules: LoadedSchedule[];
  /** Injectable clock for tests; defaults to the wall clock. */
  now?: () => Date;
}

// A single setTimeout maxes out at ~24.8 days and drifts over long sleeps; cap each wait so a long
// interval (or a suspended machine) re-checks against the wall clock rather than firing wildly early/late.
const MAX_WAIT_MS = 6 * 60 * 60 * 1000; // 6h

export function createScheduler({ agent, stateRoot, schedules, now = () => new Date() }: SchedulerOptions): Scheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  /** Fire one schedule's turn: claim the slot (persist lastFired BEFORE invoking), then drive the turn
   *  and log its outcome. Total — never throws (the timer callback that calls it is void). */
  async function fire(s: LoadedSchedule): Promise<void> {
    const session = scheduleSession(s.name);
    // Claim the slot before the invoke so a crash mid-turn does not re-fire this slot on restart.
    const fires: Fires = loadFires(stateRoot);
    fires[s.name] = now().toISOString();
    try {
      saveFires(stateRoot, fires);
    } catch (e) {
      // Can't persist the claim → skip this fire rather than risk an infinite catch-up loop on restart.
      log.error(`[schedule] ${s.name}: cannot persist fire state, skipping this run: ${String(e)}`);
      return;
    }
    const startedAt = Date.now();
    log.info(`[schedule] ${s.name} firing (session=${session})`);
    try {
      let failed: string | undefined;
      for await (const e of agent.invoke({ session }, { text: s.prompt })) {
        if (e.type === "failed") failed = e.details;
      }
      if (failed) log.error(`[schedule] ${s.name} failed (${Date.now() - startedAt}ms): ${failed}`);
      else log.info(`[schedule] ${s.name} completed (${Date.now() - startedAt}ms)`);
    } catch (e) {
      // invoke shouldn't throw (SPEC MUST 2 turns failures into events), but stay total regardless.
      log.error(`[schedule] ${s.name} errored (${Date.now() - startedAt}ms): ${String(e)}`);
    }
  }

  /** Arm a timer for `at`, capped so a long wait re-checks the wall clock instead of trusting one sleep. */
  function arm(s: LoadedSchedule, at: Date): void {
    if (stopped) return;
    const delay = Math.min(Math.max(0, at.getTime() - now().getTime()), MAX_WAIT_MS);
    timers.set(
      s.name,
      setTimeout(() => {
        if (stopped) return;
        if (now().getTime() >= at.getTime()) void fireThenReArm(s);
        else arm(s, at); // woke early (the cap) — keep waiting for the real instant
      }, delay),
    );
  }

  /** Fire, then arm the NEXT run computed from now — so a slow fire never double-fires the same slot and
   *  missed slots collapse to the single catch-up already done. */
  async function fireThenReArm(s: LoadedSchedule): Promise<void> {
    await fire(s);
    const due = nextRun(s.cron, s.tz, now());
    if (due) arm(s, due);
  }

  return {
    start() {
      stopped = false;
      const fires = loadFires(stateRoot);
      const current = now();
      for (const s of schedules) {
        // Anchor on the last fire (catch-up basis), or `now` on a first-ever run so a brand-new schedule
        // never back-fires before the process first booted.
        const lastFired = fires[s.name];
        const anchor = lastFired ? new Date(lastFired) : current;
        const due = nextRun(s.cron, s.tz, anchor);
        if (!due) {
          log.warn(`[schedule] ${s.name}: cron "${s.cron}" will never fire again — not armed`);
          continue;
        }
        if (due.getTime() <= current.getTime()) {
          log.info(`[schedule] ${s.name}: catching up a missed run`);
          void fireThenReArm(s); // overdue → fire once, then arm the next
        } else {
          arm(s, due);
        }
      }
    },
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
