/** Resident cron and wake polling. */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import { type Agent, SESSION_BUSY_CODE } from "../agent.ts";
import { PortFailure } from "../effect-port.ts";
import { beginWork } from "../channels/busy.ts";
import { log } from "../log.ts";
import { appendRun } from "./audit.ts";
import { nextRun } from "./cron.ts";
import type { LoadedSchedule } from "./schedule.ts";
import { loadFires, saveFires } from "./state.ts";
import { deferWakeup, takeFirstDueWakeup, type Wakeup } from "./wakeups.ts";

/** A schedule shares one continuing conversation without depending on engine session storage. */
export function scheduleSession(name: string): string {
  return `schedule:${name}`;
}

export interface Scheduler {
  /** Arm schedules and catch up overdue work once. */
  start(): void;
  /** Cancel pending waits. */
  stop(): void;
}

export interface SchedulerOptions {
  agent: Agent;
  stateRoot: string;
  schedules: LoadedSchedule[];
  /** Override wall-clock dates; elapsed time and waits use the Effect clock. */
  now?: () => Date;
  /** External slot delivery owns cron timers and catch-up; local wake polling still runs. */
  externalClock?: boolean;
}

// Recheck the wall clock across long waits and machine suspension; never exceed setTimeout's limit.
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
const WAKEUP_POLL_MS = 30_000;

/** The iterator is a Promise port inside an uninterruptible claimed occurrence, including its cleanup. */
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
        let reply = "";
        for await (const e of agent.invoke({ session }, { text: prompt })) {
          if (e.type === "text") reply += e.delta;
          if (e.type === "failed") {
            failed = e.details;
            busy = e.code === SESSION_BUSY_CODE;
          }
        }
        return { busy: failed !== undefined && busy, failed, reply };
      },
      catch: (cause) => new PortFailure(cause),
    }).pipe(
      Effect.match({
        onSuccess: (result) => {
          if (result.failed) log.error(`[schedule] ${label} failed (${elapsed()}ms): ${result.failed}`);
          else log.info(`[schedule] ${label} completed (${elapsed()}ms)`);
          return { ...result, ms: elapsed() };
        },
        onFailure: (error) => {
          // An iterator throw violates SPEC MUST 2 and is never a replay-safe busy rejection.
          log.error(`[schedule] ${label} errored (${elapsed()}ms): ${String(error.cause)}`);
          return { busy: false, failed: String(error.cause), reply: "", ms: elapsed() };
        },
      }),
    );
  });
}

export interface ScheduleFireOutcome {
  fired: boolean;
  /** A slot-keyed delivery whose slot (or a later one) was already claimed. */
  skippedReason?: string;
  failed?: string;
  ms: number;
}

/** Shared resident/external claim → run → audit. */
export function fireScheduleOnce(opts: {
  agent: Agent;
  stateRoot: string;
  schedule: LoadedSchedule;
  slot?: Date;
  now?: () => Date;
}): Effect.Effect<ScheduleFireOutcome, PortFailure> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const { agent, stateRoot, schedule: s, slot, now = () => new Date(clock.currentTimeMillisUnsafe()) } = opts;
    const skippedReason = yield* Effect.try({
      try: () => {
        const fires = loadFires(stateRoot);
        const last = fires[s.name];
        if (slot && last && new Date(last).getTime() >= slot.getTime()) {
          const reason = `slot ${slot.toISOString()} already fired (lastFired=${last})`;
          log.info(`[schedule] ${s.name}: skipping — ${reason}`);
          return reason;
        }
        fires[s.name] = (slot ?? now()).toISOString();
        saveFires(stateRoot, fires);
        return undefined;
      },
      catch: (cause) => new PortFailure(cause),
    });
    if (skippedReason !== undefined) return { fired: false, skippedReason, ms: 0 };
    const firedAt = now().toISOString();
    const r = yield* runTurn(agent, s.name, scheduleSession(s.name), s.prompt);
    appendRun(stateRoot, {
      name: s.name,
      session: scheduleSession(s.name),
      firedAt,
      ms: r.ms,
      outcome: r.failed ? "failed" : "completed",
      reply: r.failed ? undefined : r.reply,
      error: r.failed,
    });
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
      now = () => new Date(clock.currentTimeMillisUnsafe()),
      externalClock = false,
    } = options;
    const loops = new Set<Fiber.Fiber<unknown, unknown>>();
    let stopped = false;

    const launch = (label: string, work: Effect.Effect<void>): void => {
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
    };
    const cronLoop = (s: LoadedSchedule, first: Date) =>
      Effect.gen(function* () {
        let due: Date | undefined = first;
        while (due) {
          while (now().getTime() < due.getTime()) {
            yield* Effect.sleep(Math.min(due.getTime() - now().getTime(), MAX_WAIT_MS));
          }
          yield* fireScheduleOnce({ agent, stateRoot, schedule: s, now }).pipe(
            Effect.catchTag("PortFailure", (error) =>
              Effect.sync(() => {
                log.error(
                  `[schedule] ${s.name}: fire failed (skipping this run, schedule stays armed): ${String(error.cause)}`,
                );
                appendRun(stateRoot, {
                  name: s.name,
                  session: scheduleSession(s.name),
                  firedAt: now().toISOString(),
                  ms: 0,
                  outcome: "failed",
                  error: `run skipped — fire failed: ${String(error.cause)}`,
                });
              }),
            ),
            Effect.uninterruptible,
          );
          due = nextRun(s.cron, s.tz, now());
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
            const firedAt = now().toISOString();
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
              log.error(`[schedule] ${label}: occurrence skipped (session busy); next fires per cron`);
            }
            // The recurrence was advanced by the claim; only a retained one-shot is audited deferred.
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

    return {
      start() {
        stopped = false;
        // A boot-time read fault stays synchronous, before any timers or turns are started.
        const fires = externalClock ? {} : loadFires(stateRoot);
        const current = now();
        for (const s of externalClock ? [] : schedules) {
          if (stopped) break;
          const last = fires[s.name];
          const due = nextRun(s.cron, s.tz, last ? new Date(last) : current);
          if (!due) {
            log.warn(`[schedule] ${s.name}: cron "${s.cron}" will never fire again — not armed`);
            continue;
          }
          if (due.getTime() <= current.getTime()) log.info(`[schedule] ${s.name}: catching up a missed run`);
          launch(s.name, cronLoop(s, due));
        }
        if (!stopped) launch("wake-up poll", wakeLoop);
      },
      stop() {
        stopped = true;
        for (const loop of loops) loop.interruptUnsafe();
      },
    };
  });
}
