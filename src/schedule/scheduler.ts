/** Resident cron and wake polling. */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import { type Agent, SESSION_BUSY_CODE } from "../agent.ts";
import { PortFailure } from "../effect-port.ts";
import { beginWork } from "../channels/busy.ts";
import { log } from "../log.ts";
import { nextRun } from "./cron.ts";
import { basename } from "node:path";
import type { ModuleLoadFailure } from "../loader.ts";
import { type Schedule, scheduleSession } from "./schedule.ts";
import { claimSlot, type Fire, latestFire, settleClaim } from "./state.ts";
import { deferWakeup, takeFirstDueWakeup, type Wakeup } from "./wakeups.ts";

/**
 * Account for a claim whose turn never reported. The slot is claimed BEFORE the turn runs and shutdown does not wait
 * for that turn (see `AgentService.close`), so a restart landing mid-fire leaves a claim that the next boot skips —
 * the exact silence the history exists to prevent. Settled once, at the next boot, which also makes it idempotent.
 *
 * The claim is the ONE record here: it IS the decision, and the outcome is written back into it.
 *
 * NOT re-fired: a turn that kills its own process would then replay on every boot. Cron only: a killed wake-up
 * leaves no claim behind to reconcile (`takeFirstDueWakeup` removes it before the turn starts).
 *
 * THE NEWEST CLAIM ONLY. A schedule's loop runs one turn at a time, so a killed process leaves exactly one claim
 * unsettled — the one it was in. Walking the whole retained window would add nothing a resident process can
 * produce, and would instead rewrite every claim an OLDER FORMAT left without an outcome, turning a window of runs
 * that actually succeeded into `interrupted`.
 *
 * KNOWN FALSE POSITIVE: a second scheduler booting while the first is mid-turn sees a claim nothing accounts for
 * YET, and reports it; the first process then overwrites the outcome when its turn settles. Telling them apart needs
 * the claimer's liveness, which is a lease, not a claim — and the whole point of the claim is that it needs none.
 */
function markInterruptedFire(stateRoot: string, name: string, fire: Fire | undefined): void {
  if (fire === undefined || fire.outcome !== undefined) return;
  log.warn(
    `[schedule] ${name}: the fire claimed at ${fire.firedAt} never finished — the process stopped mid-turn ` +
      `and that slot stays skipped (see \`fastagent schedules list\`)`,
  );
  // `fire.slot` came from a claim file name, which `listClaims` admits only when it round-trips through this same
  // conversion — so the Date is valid and `settleClaim` writes back the file it was read from. No duration: this
  // turn was never timed, and the process that could have timed it is gone.
  settleClaim(stateRoot, name, new Date(fire.slot), "interrupted");
}

export interface Scheduler {
  /** Arm schedules, account for a fire the previous run was killed in, and catch up overdue work once. */
  start(): void;
  /** Cancel pending waits. */
  stop(): void;
  /** The schedules armed now: the loaded set, as each re-read of `schedules/` left it. */
  current(): readonly Schedule[];
}

/** What a re-read of `schedules/` found: the valid files, and the ones that are not. */
export interface ScheduleLoad {
  schedules: readonly Schedule[];
  failures: readonly ModuleLoadFailure[];
}

export interface SchedulerOptions {
  agent: Agent;
  stateRoot: string;
  /** Every schedule this serve loaded at start (a file that is not valid refused the start before this). */
  schedules: readonly Schedule[];
  /**
   * Re-read `schedules/`, every {@link RELOAD_MS}: a schedule added, changed or removed while the process runs is
   * armed, re-armed or disarmed without a restart. Absent, the start's set is fixed.
   */
  reload?: () => Promise<ScheduleLoad>;
  /** Told when the armed set or a next instant changed: a re-read changed it, or a schedule fired (AgentCore mirrors
   *  it into alarms). */
  onChange?: () => void;
  /** Override wall-clock dates; elapsed time and waits use the Effect clock. */
  now?: () => Date;
}

/**
 * The longest a single armed wait sleeps before looking at the wall clock again.
 *
 * WHAT IT BUYS, and only this: a wait LONGER than one cap (a daily, weekly or monthly cron) re-reads the wall
 * clock every 6 hours, so a clock that jumped forward is noticed within that, instead of after the whole
 * original delay. MEASURED (2026-09-22): the same jump under a wait SHORTER than the cap changes nothing — a
 * minute cron whose wall clock jumped 10 minutes past its slot still fired at t+51.4s, when its one timer was
 * always going to. So this is not a resume guarantee and must not be read as one; it bounds lateness for the
 * long waits at 6 hours.
 *
 * NOT about `setTimeout`'s 2^31-1 ms ceiling: `Effect.sleep` already splits a longer delay by itself
 * (effect/src/internal/effect.ts, `sleepMillis`).
 */
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
const WAKEUP_POLL_MS = 30_000;
/** How often `schedules/` is re-read: an edit is armed within this. */
const RELOAD_MS = 30_000;

/** Whether two loads of one schedule would fire the same turns at the same instants. */
const sameSchedule = (a: Schedule, b: Schedule): boolean => a.cron === b.cron && a.tz === b.tz && a.prompt === b.prompt;

/** The schedule a `schedules/<name>.md` failure label names. */
const scheduleNameOf = (label: string): string => basename(label, ".md");

/**
 * ONE LINE, ALWAYS: the tail a failure contributes to its log line, as `: <text>`, or nothing when there is none.
 *
 * `log.ts` prefixes only the first line, so a newline anywhere in here emits a second line that is byte-for-byte a
 * real record (`ERROR [schedule] daily failed (1ms): DISK ON FIRE`) — and a failure detail can carry model or
 * provider text. Folding also keeps the line-oriented consumers — `docker logs`, journald, CloudWatch — reading one
 * fire as one event.
 */
function oneLine(text: string): string {
  const folded = text.replace(/\s+/g, " ").trim();
  return folded === "" ? "" : `: ${folded}`;
}

/**
 * The iterator is a Promise port inside an uninterruptible claimed occurrence, including its cleanup.
 *
 * WHAT THE TURN SAID IS NOT LOGGED. It is already durable: every fire runs in the session named in the line below
 * (`schedule:<name>` for a schedule, the asking conversation for a wake-up), and a session is persisted under
 * `<stateRoot>/sessions/` like any other. Copying the reply into the log would be a second store of the same text,
 * unstructured, in a stream with a wider audience and a bound that differs per host.
 */
function runTurn(agent: Agent, label: string, session: string, prompt: string) {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const startedAt = clock.currentTimeMillisUnsafe();
    const elapsed = () => clock.currentTimeMillisUnsafe() - startedAt;
    log.info(`[schedule] ${label} firing (session=${session})`);
    return yield* Effect.tryPromise({
      try: async () => {
        let failed: string | undefined;
        let busy = false;
        // The text deltas are iterated and dropped. Accumulating them would be a second copy of what the session
        // already holds, and no caller here reads it — the outcome is the whole record (docs/design/core.md §8).
        for await (const e of agent.invoke({ session }, { text: prompt })) {
          if (e.type === "failed") {
            failed = e.details;
            busy = e.code === SESSION_BUSY_CODE;
          }
        }
        return { busy: failed !== undefined && busy, failed };
      },
      catch: (cause) => new PortFailure(cause),
    }).pipe(
      Effect.match({
        onSuccess: (result) => {
          // BUSY IS NOT A FAILURE, and this line is where that distinction has to land: the claim file says
          // `skipped`, but `docker logs` / CloudWatch is the first place anyone looks, and
          // it kept saying `ERROR … failed: busy`. "The previous turn is still running" and "the model call died"
          // need different reactions — a session-busy rejection carries `failed` only because that is the SPEC's
          // one terminal event shape, which is a wire detail, not a verdict.
          if (result.busy) log.info(`[schedule] ${label}: occurrence skipped (session busy) (${elapsed()}ms)`);
          else if (result.failed) log.error(`[schedule] ${label} failed (${elapsed()}ms)${oneLine(result.failed)}`);
          else log.info(`[schedule] ${label} completed (${elapsed()}ms)`);
          return { ...result, ms: elapsed() };
        },
        onFailure: (error) => {
          // An iterator throw violates SPEC MUST 2 and is never a replay-safe busy rejection.
          log.error(`[schedule] ${label} errored (${elapsed()}ms)${oneLine(String(error.cause))}`);
          return { busy: false, failed: String(error.cause), ms: elapsed() };
        },
      }),
    );
  });
}

export interface ScheduleFireOutcome {
  fired: boolean;
  /** A delivery whose slot was already claimed, or which is older than the newest claim (a stale replay). */
  skippedReason?: string;
  failed?: string;
  /**
   * The occurrence was claimed but the turn was refused because the previous one is still running — the overlap
   * policy, not a fault. Reported apart from `failed` because an operator reacts to the two differently, and a
   * clock that reads `failed` would be reading an error that is not one.
   */
  skipped?: true;
  ms: number;
}

/** Shared resident/external claim → run → settle. */
export function fireScheduleOnce(opts: {
  agent: Agent;
  stateRoot: string;
  schedule: Schedule;
  /** The instant this fire is FOR. Two schedulers agree on it, which is what makes the claim exclude. */
  slot: Date;
  now?: () => Date;
}): Effect.Effect<ScheduleFireOutcome, PortFailure> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const { agent, stateRoot, schedule: s, slot, now = () => new Date(clock.currentTimeMillisUnsafe()) } = opts;
    const firedAt = now();
    const skippedReason = yield* Effect.try({
      try: () => {
        // The DECISION to fire is the claim, and it is atomic: several schedulers over one state root — two
        // `start`s, a restart overlapping its predecessor, an external clock racing the resident one — take the
        // same slot, and exactly one of them runs it. It is also the ONLY state write on this path, so a state
        // failure cannot burn a slot that was already claimed.
        const claim = claimSlot(stateRoot, s.name, slot, firedAt);
        if (claim.taken) return undefined;
        if (claim.why === "duplicate") {
          // Ordinary: the same delivery arrived twice, or another scheduler has this slot and is running it.
          const reason = `slot ${slot.toISOString()} is already claimed — a duplicate delivery, or another scheduler has it`;
          log.info(`[schedule] ${s.name}: skipping — ${reason}`);
          return reason;
        }
        // Not ordinary: this instant will never run. The common way in is a wall clock that moved backwards (a VM
        // resume, a host clock correction), which keeps producing slots behind the newest claim. No claim was taken,
        // so there is nothing to record: it is a WARN where the benign duplicate is an info line.
        const reason = `slot ${slot.toISOString()} is stale: ${claim.newest} was already claimed, so this instant is skipped`;
        log.warn(`[schedule] ${s.name}: skipping — ${reason}`);
        return reason;
      },
      catch: (cause) => new PortFailure(cause),
    });
    if (skippedReason !== undefined) return { fired: false, skippedReason, ms: 0 };
    const r = yield* runTurn(agent, s.name, scheduleSession(s.name), s.prompt);
    // OVERLAP IS NOT FAILURE. The claim still stands — this occurrence is decided and will not be retried — but
    // what decided it was the previous turn still holding `schedule:<name>`, which is the policy every scheduler
    // names (k8s `concurrencyPolicy: Forbid`, Temporal's `Skip`) and none of them reports as an error.
    if (r.busy) {
      settleClaim(stateRoot, s.name, slot, "skipped", r.ms);
      return {
        fired: false,
        skippedReason: `the previous turn of "${s.name}" is still running — this occurrence is skipped, the next fires per cron`,
        skipped: true as const,
        ms: r.ms,
      };
    }
    settleClaim(stateRoot, s.name, slot, r.failed ? "failed" : "completed", r.ms);
    return { fired: true, failed: r.failed, ms: r.ms };
  }).pipe(Effect.uninterruptible);
}

/** Wakes re-enter a chat session; identify the agent's own instruction and its cancellation handle. */
function wakeEnvelope(w: Wakeup): string {
  const tag = w.cron
    ? `[wake-up ${w.id} fired — YOUR recurring self-scheduled turn (cron "${w.cron}"${w.tz ? ` ${w.tz}` : ""}), not a user message; unwake({ id: "${w.id}" }) stops it]`
    : `[wake-up ${w.id} fired — YOUR self-scheduled turn, not a user message]`;
  return `${tag} ${w.prompt}`;
}

export function createScheduler(options: SchedulerOptions): Effect.Effect<Scheduler> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const fork = Effect.runForkWith(yield* Effect.context<never>());
    const {
      agent,
      stateRoot,
      schedules,
      reload,
      onChange,
      now = () => new Date(clock.currentTimeMillisUnsafe()),
    } = options;
    const loops = new Set<Fiber.Fiber<unknown, unknown>>();
    let stopped = false;
    /** The armed set, by name, with the loop that fires each. */
    const armed = new Map<string, { schedule: Schedule; loop?: Fiber.Fiber<unknown, unknown> }>();

    const launch = (label: string, work: Effect.Effect<void>): Fiber.Fiber<unknown, unknown> =>
      fork(
        Effect.withFiber((fiber) => {
          // Publish ownership before a synchronous invoke callback can re-enter stop().
          loops.add(fiber);
          return work.pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                if (!Cause.hasInterruptsOnly(cause))
                  log.error(`[schedule] ${label}: stopped unexpectedly: ${String(Cause.squash(cause))}`);
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                loops.delete(fiber);
              }),
            ),
          );
        }),
      );
    const cronLoop = (s: Schedule, first: Date) =>
      Effect.gen(function* () {
        let due: Date | undefined = first;
        while (due) {
          // SLEEP, THEN LOOK AGAIN, in both directions: forward, a jumped clock is noticed a cap early
          // ({@link MAX_WAIT_MS}); backward — an NTP correction, a VM restored from a snapshot — waking on the
          // timer alone would fire a slot that has not arrived yet and CLAIM it, burning an occurrence that was
          // still ahead.
          while (now().getTime() < due.getTime()) {
            yield* Effect.sleep(Math.min(due.getTime() - now().getTime(), MAX_WAIT_MS));
          }
          // `slot: due` is what two schedulers have in common: both compute the same cron instant, so both try to
          // claim the same name and exactly one wins. Claiming `now()` would give them different names.
          yield* fireScheduleOnce({ agent, stateRoot, schedule: s, slot: due, now }).pipe(
            Effect.catchTag("PortFailure", (error) =>
              Effect.sync(() => {
                // Nothing to record: this fault happens BEFORE the claim exists (that is what keeps the slot
                // unburned), so there is no claim to write an outcome into.
                log.error(
                  `[schedule] ${s.name}: fire failed (skipping this run, schedule stays armed): ${String(error.cause)}`,
                );
              }),
            ),
            Effect.uninterruptible,
          );
          due = nextRun(s.cron, s.tz, now());
          // Its next instant moved: whoever mirrors the armed set (AgentCore's alarms) hears it.
          onChange?.();
        }
      });

    const wakeOnce = Effect.gen(function* () {
      const w = yield* Effect.try({
        try: () => takeFirstDueWakeup(stateRoot, now()),
        catch: (cause) => new PortFailure(cause),
      });
      if (!w) return false;
      yield* Effect.acquireUseRelease(
        Effect.sync(beginWork),
        () =>
          Effect.gen(function* () {
            const label = `wake ${w.id.slice(0, 8)}`;
            const r = yield* runTurn(agent, label, w.session, wakeEnvelope(w));
            let kept = false;
            if (r.busy && !w.cron) {
              kept = yield* Effect.try({
                try: () => deferWakeup(stateRoot, w, new Date(now().getTime() + WAKEUP_POLL_MS)),
                catch: (cause) => new PortFailure(cause),
              });
              if (kept) log.info(`[schedule] ${label}: session busy — retrying next poll`);
              else log.error(`[schedule] ${label}: dropped after too many busy retries`);
            } else if (r.busy && w.cron) {
              // `runTurn` already said it was skipped for a busy session; this adds the one thing it cannot know —
              // that a recurring wake has a next occurrence, so nothing is deferred and nothing is lost.
              log.info(`[schedule] ${label}: next fires per cron`);
            }
            // A wake-up has no claim to settle (it is removed from the store before the turn starts), so its whole
            // record is the log lines above and `runTurn`'s — deferred, dropped, failed, completed.
          }),
        (done) => Effect.sync(done),
      );
      return true;
    }).pipe(
      // Log storage faults before a pending stop can replace the typed failure with interruption.
      Effect.catchTag("PortFailure", (error) =>
        Effect.sync(() => {
          log.error(`[schedule] wake-up poll failed (continuing next poll): ${String(error.cause)}`);
          return false;
        }),
      ),
      Effect.uninterruptible,
    );
    const wakeLoop = Effect.gen(function* () {
      for (;;) {
        while (yield* wakeOnce) {
          // Claim only after the preceding occurrence settles.
        }
        yield* Effect.sleep(WAKEUP_POLL_MS);
      }
    });

    /** Arm `s` to fire next at `due` (or say it never will), replacing whatever loop armed it before. */
    const arm = (s: Schedule, due: Date | undefined): void => {
      armed.get(s.name)?.loop?.interruptUnsafe();
      if (!due) {
        log.warn(`[schedule] ${s.name}: cron "${s.cron}" will never fire again — not armed`);
        armed.set(s.name, { schedule: s });
        return;
      }
      armed.set(s.name, { schedule: s, loop: launch(s.name, cronLoop(s, due)) });
    };

    /** The failures last reported, so a broken file is said when it breaks, not on every re-read. */
    let reported = new Set<string>();
    /**
     * One re-read of `schedules/`. An edit takes effect from the NEXT instant after now: catching up is for what was
     * missed while the process was down, not for a cron that was just written. A file that stops being valid keeps
     * the definition it last had, and says so; one that was never valid is not armed.
     */
    const reloadOnce = (load: () => Promise<ScheduleLoad>) =>
      Effect.gen(function* () {
        const loaded = yield* Effect.tryPromise({ try: load, catch: (cause) => new PortFailure(cause) });
        const next = new Map(loaded.schedules.map((s) => [s.name, s] as const));
        const said = new Set<string>();
        for (const f of loaded.failures) {
          const name = scheduleNameOf(f.label);
          const kept = armed.get(name);
          if (kept) next.set(name, kept.schedule);
          const line = `${f.label}: ${f.message}`;
          said.add(line);
          if (!reported.has(line)) {
            log.error(
              `[schedule] ${f.label} is not a valid schedule (${f.message}) — ` +
                (kept ? "it keeps its previous definition" : "not armed"),
            );
          }
        }
        reported = said;
        let changed = false;
        for (const [name, { loop }] of armed) {
          if (next.has(name)) continue;
          loop?.interruptUnsafe();
          armed.delete(name);
          log.info(`[schedule] ${name}: removed`);
          changed = true;
        }
        const current = now();
        for (const s of next.values()) {
          const before = armed.get(s.name)?.schedule;
          if (before && sameSchedule(before, s)) continue;
          log.info(`[schedule] ${s.name}: ${before ? "changed" : "added"} (cron "${s.cron}"${s.tz ? ` ${s.tz}` : ""})`);
          arm(s, nextRun(s.cron, s.tz, current));
          changed = true;
        }
        if (changed) onChange?.();
      }).pipe(
        Effect.catchTag("PortFailure", (error) =>
          Effect.sync(() => {
            // The armed set stands: a directory that cannot be read now is not a reason to disarm what was.
            log.error(`[schedule] re-reading schedules/ failed (keeping what is armed): ${String(error.cause)}`);
          }),
        ),
      );
    const reloadLoop = (load: () => Promise<ScheduleLoad>) =>
      Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(RELOAD_MS);
          yield* reloadOnce(load);
        }
      });

    return {
      start() {
        stopped = false;
        // ONE claim read per schedule — the newest — for the two planes that must agree about it: the reconciler
        // (was that fire ever reported?) and catch-up (where does the next run resume?). A read fault on it stays
        // synchronous, before any timers or turns are started: a schedule whose newest claim cannot be read is not
        // one to run blind, it is a boot failure. The rest of the window is history, and history does not gate a
        // boot (`latestFire`).
        const lastFires = new Map<string, string>();
        for (const s of schedules) {
          const fire = latestFire(stateRoot, s.name);
          if (fire !== undefined) lastFires.set(s.name, fire.firedAt);
          markInterruptedFire(stateRoot, s.name, fire);
        }
        const current = now();
        for (const s of schedules) {
          if (stopped) break;
          // FROM THE LAST FIRE, or from now when there was none. A schedule that has never fired does not catch
          // up the occurrence it missed while the process was down: nothing recorded that it was ever armed then,
          // so "missed" is not a fact this process has. Every boot after the first resumes from the claim.
          const last = lastFires.get(s.name);
          const due = nextRun(s.cron, s.tz, last ? new Date(last) : current);
          if (due && due.getTime() <= current.getTime()) log.info(`[schedule] ${s.name}: catching up a missed run`);
          arm(s, due);
        }
        if (!stopped) launch("wake-up poll", wakeLoop);
        if (!stopped && reload) launch("schedules/ re-read", reloadLoop(reload));
      },
      current() {
        return [...armed.values()].map((a) => a.schedule);
      },
      stop() {
        stopped = true;
        for (const loop of loops) loop.interruptUnsafe();
      },
    };
  });
}
