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
import { type Agent, SESSION_BUSY_CODE } from "../agent.ts";
import { log } from "../log.ts";
import { appendRun } from "./audit.ts";
import { nextRun } from "./cron.ts";
import type { LoadedSchedule } from "./schedule.ts";
import { loadFires, saveFires } from "./state.ts";
import { deferWakeup, takeFirstDueWakeup } from "./wakeups.ts";

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
// How often to poll the agent's self-scheduled wake-ups (wakeups.ts). A wake fires within this of its
// due time — fine for "wake me in N minutes"; cheap (reads a small JSON, writes only when one is due).
const WAKEUP_POLL_MS = 30 * 1000;

export function createScheduler({ agent, stateRoot, schedules, now = () => new Date() }: SchedulerOptions): Scheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let wakeupTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** Drive ONE turn (a cron fire or a wake-up) and log its outcome. Total — never throws (its callers are
   *  void-scheduled). Output is the agent's tools' job; this only fires and logs. Returns the turn's audit
   *  material — `failed` (details, if it failed), the accumulated `reply` text, `ms` — plus `busy`: whether
   *  it failed specifically because the session was BUSY (the turn never started) — the ONLY replay-safe
   *  reason to re-fire a wake-up; every other outcome is terminal (side effects may have run). */
  async function runTurn(
    label: string,
    session: string,
    prompt: string,
  ): Promise<{ busy: boolean; failed?: string; reply: string; ms: number }> {
    const startedAt = Date.now();
    log.info(`[schedule] ${label} firing (session=${session})`);
    try {
      let failed: string | undefined;
      let busy = false;
      let reply = "";
      for await (const e of agent.invoke({ session }, { text: prompt })) {
        if (e.type === "text") reply += e.delta;
        if (e.type === "failed") {
          failed = e.details;
          busy = e.code === SESSION_BUSY_CODE; // structured (SPEC §8), not a details-text match
        }
      }
      if (failed) log.error(`[schedule] ${label} failed (${Date.now() - startedAt}ms): ${failed}`);
      else log.info(`[schedule] ${label} completed (${Date.now() - startedAt}ms)`);
      return { busy: failed !== undefined && busy, failed, reply, ms: Date.now() - startedAt };
    } catch (e) {
      // invoke shouldn't throw (SPEC MUST 2 turns failures into events), but stay total regardless. A throw
      // is not the busy case, so don't defer on it.
      log.error(`[schedule] ${label} errored (${Date.now() - startedAt}ms): ${String(e)}`);
      return { busy: false, failed: String(e), reply: "", ms: Date.now() - startedAt };
    }
  }

  /** Fire one schedule's turn: claim the slot (persist lastFired BEFORE invoking) so a crash mid-turn
   *  does not re-fire this slot on restart, then run the turn. */
  async function fire(s: LoadedSchedule): Promise<void> {
    const fires = loadFires(stateRoot);
    fires[s.name] = now().toISOString();
    try {
      saveFires(stateRoot, fires);
    } catch (e) {
      // Can't persist the claim → skip this fire rather than risk an infinite catch-up loop on restart.
      log.error(`[schedule] ${s.name}: cannot persist fire state, skipping this run: ${String(e)}`);
      return;
    }
    const firedAt = now().toISOString();
    const r = await runTurn(s.name, scheduleSession(s.name), s.prompt);
    appendRun(stateRoot, {
      name: s.name,
      session: scheduleSession(s.name),
      firedAt,
      ms: r.ms,
      outcome: r.failed ? "failed" : "completed",
      reply: r.failed ? undefined : r.reply,
      error: r.failed,
    });
  }

  /**
   * Fire every due self-scheduled wake-up, ONE at a time (claim → fire → claim next) so a crash loses at
   * most one occurrence. Each fires back into the session it was set in. Busy handling splits by kind: a
   * ONE-SHOT that failed because the session was BUSY (`code: session_busy` — the turn never started; the
   * very case "wake me in 10 min" hits while the user is still chatting) is deferred to the next poll,
   * bounded, because a dropped one-shot has no "next time"; a RECURRING busy occurrence is skipped
   * immediately (its claim already advanced the entry — the next occurrence comes by definition). Any
   * other failure is terminal for that occurrence (the turn ran — re-running risks duplicate side effects).
   */
  async function pollWakeups(): Promise<void> {
    for (;;) {
      if (stopped) break; // stop() must halt an in-flight drain, like it clears the cron timers
      const w = takeFirstDueWakeup(stateRoot, now());
      if (!w) break;
      const label = `wake ${w.id.slice(0, 8)}`;
      const firedAt = now().toISOString();
      const r = await runTurn(label, w.session, w.prompt);
      // Re-fire ONLY on a busy session (the turn never started — replay-safe). A wake is one-shot, so a
      // busy-skip that just dropped it would lose it forever; defer + bounded retry. Every OTHER outcome is
      // terminal (already claimed/removed) — re-running a turn that DID start risks duplicate side effects.
      // Busy handling differs by kind. ONE-SHOT: defer (bounded) — it has no "next time", dropping it
      // would lose it forever. RECURRING: the claim already ADVANCED the entry to the next instant (see
      // takeFirstDueWakeup), so a busy occurrence is simply SKIPPED and audited — the next one comes by
      // definition, and never touching the stored entry here is what keeps unwake/cancel race-free.
      let kept = false;
      if (r.busy && !w.cron) {
        kept = deferWakeup(stateRoot, w, new Date(now().getTime() + WAKEUP_POLL_MS));
        if (kept) log.info(`[schedule] ${label}: session busy — retrying next poll`);
        else log.error(`[schedule] ${label}: dropped after too many busy retries`);
      } else if (r.busy && w.cron) {
        log.error(`[schedule] ${label}: occurrence skipped (session busy); next fires per cron`);
      }
      // Audit honesty: `deferred` ONLY when the same occurrence was actually re-scheduled. A busy one-shot
      // dropped at the ceiling, and a busy recurring occurrence (skipped — its recurrence survives), are
      // both FINAL for that occurrence → `failed`.
      appendRun(stateRoot, {
        name: "wake",
        session: w.session,
        firedAt,
        ms: r.ms,
        outcome: r.busy ? (kept ? "deferred" : "failed") : r.failed ? "failed" : "completed",
        reply: r.failed || r.busy ? undefined : r.reply,
        error: r.busy
          ? kept
            ? undefined
            : w.cron
              ? "occurrence skipped (session busy); the recurrence continues"
              : "dropped after too many busy retries"
          : r.failed,
      });
    }
  }

  /** Drain due wake-ups, then chain the next poll AFTER — never overlapping two drains. TOTAL: a state-IO
   *  fault (an unreadable store) is caught + logged and the chain continues, never a crash / a silent stop
   *  (this is `void`-scheduled, so an escaping throw would be an unhandled rejection). */
  async function pumpWakeups(): Promise<void> {
    if (stopped) return;
    try {
      await pollWakeups();
    } catch (e) {
      log.error(`[schedule] wake-up poll failed (continuing next poll): ${String(e)}`);
    }
    if (stopped) return;
    wakeupTimer = setTimeout(() => void pumpWakeups(), WAKEUP_POLL_MS);
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
      // Self-scheduled wake-ups: drain now (catch any overdue while the process was down), then chain the
      // next poll AFTER this drain finishes — a CHAIN, not setInterval, so a wake turn longer than the poll
      // interval never overlaps two drains (which would break the one-at-a-time claim→fire→claim promise).
      void pumpWakeups();
    },
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (wakeupTimer) clearTimeout(wakeupTimer);
      wakeupTimer = undefined;
    },
  };
}
