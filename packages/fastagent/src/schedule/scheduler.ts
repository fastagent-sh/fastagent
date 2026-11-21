/** Resident cron scheduler for declarative schedules. */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import { type Agent, AgentError, type Message, type SendRequest } from "@fastagent-sh/client/agent-api";
import { conversationSessions } from "./conversation-sessions.ts";
import { PromiseFailure } from "../promise-bridge.ts";
import { beginWork } from "../busy.ts";
import { log } from "../log.ts";
import { nextRun } from "./cron.ts";
import type { Schedule } from "./schedule.ts";
import type { ClockStore } from "./clock.ts";
import { claimSlot, type Fire, latestFire, settleClaim } from "./state.ts";

export interface Scheduler {
  /**
   * Arm schedules (`since` stamps schedules seen for the first time, as a deploy's alarm carries), account for a fire
   * the previous run was killed in, and catch up overdue work once. Rejects when a schedule's newest fire cannot be
   * read: a schedule is not run blind.
   */
  start(options?: { since?: Date }): Promise<void>;
  /** Claim and start every cron occurrence and wake-up due now (`since` stamps schedules seen for the first time). */
  tick(options?: { since?: Date }): Promise<void>;
  /** The earliest instant a schedule or pending wake-up in `clock` is next due, or `undefined` when nothing is. */
  nextDue(at?: Date): Promise<Date | undefined>;
  /** Cancel pending waits. */
  stop(): void;
}

/** All the scheduler asks of the agent. */
export type ScheduledAgent = {
  sessions: Pick<Agent["sessions"], "get" | "create">;
  messages: Pick<Agent["messages"], "send" | "get">;
};

export interface SchedulerOptions {
  agent: ScheduledAgent;
  /** Where the instance's clock keeps what it decided. */
  clock: ClockStore;
  /** The definition's schedules. */
  schedules: readonly Schedule[];
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
 * How one send went: refused before it ran, the message as it ended, or a wait that ended before its message did,
 * with why.
 */
type SendEnd = { refused: string; busy: boolean } | { ended: Message } | { unfinished: string };

/** What a wait for a message's end gave instead of its end, as the one line this log says it with. */
async function untilEnded(agent: ScheduledAgent, key: Parameters<Agent["messages"]["get"]>[0], signal: AbortSignal) {
  return agent.messages.get(key, { wait: Number.POSITIVE_INFINITY, signal }).then(
    (message): SendEnd => ({ ended: message }),
    (error: unknown): SendEnd => ({
      unfinished: `waiting for its end failed: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );
}

/**
 * Send one message and wait for its end; `onAccepted` hears that it was recorded. Interrupted, it stops waiting, and
 * the agent goes on: a Caller that stops waiting only lets go.
 */
async function sendAndWait(
  agent: ScheduledAgent,
  request: SendRequest,
  onAccepted: (message: Message) => void,
  signal: AbortSignal,
): Promise<SendEnd> {
  let message: Message;
  try {
    message = await agent.messages.send(request);
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    if (error.code === "unconfirmed") return { unfinished: `whether it was recorded is not known: ${error.message}` };
    return { refused: error.message, busy: error.code === "busy" };
  }
  onAccepted(message);
  return untilEnded(agent, { sessionId: message.sessionId, messageId: message.id }, signal);
}

/** How a message ended, as the one word a claim keeps, and the detail worth a log line. */
function settled(message: Message): { fire: "completed" | "failed"; detail?: string } {
  switch (message.status) {
    case "completed":
    case "incomplete":
      return { fire: "completed" };
    case "canceled":
      return { fire: "failed", detail: "canceled" };
    default:
      return { fire: "failed", detail: message.error?.message ?? `the message ended ${message.status}` };
  }
}

/**
 * One invoke, read to its message's end, with what became of it said in the log.
 *
 * WHAT THE AGENT SAID IS NOT LOGGED. It is already durable: every fire runs in the session named in the line below
 * (the schedule's own, the asking conversation's for a wake-up), kept in the instance's storage like any other.
 * Copying the reply into the log would be a second store of the same text, unstructured, in a stream with a wider
 * audience and a bound that differs per host.
 */
function runTurn(
  agent: ScheduledAgent,
  label: string,
  request: SendRequest,
  onAccepted: (message: Message) => void = () => {},
) {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const startedAt = clock.currentTimeMillisUnsafe();
    const elapsed = () => clock.currentTimeMillisUnsafe() - startedAt;
    log.info(`[schedule] ${label} firing (session=${request.sessionId})`);
    const read = yield* Effect.tryPromise({
      try: (signal) => sendAndWait(agent, request, onAccepted, signal),
      catch: (cause) => new PromiseFailure(cause),
    }).pipe(Effect.result);
    const ms = elapsed();
    if (Result.isFailure(read)) {
      // Not an AgentError: a fault of the agent's, so this fire's failure, never a refusal.
      const failed = String(read.failure.cause);
      log.error(`[schedule] ${label} errored (${ms}ms)${oneLine(failed)}`);
      return { fire: "failed" as const, busy: false, failed, ms };
    }
    const end = read.success;
    if ("unfinished" in end) {
      log.error(`[schedule] ${label} failed (${ms}ms)${oneLine(end.unfinished)}`);
      return { fire: "failed" as const, busy: false, failed: end.unfinished, ms };
    }
    if ("refused" in end) {
      // BUSY IS NOT A FAILURE: "the previous run is still going" and "the model call died" need different reactions.
      if (end.busy) log.info(`[schedule] ${label}: occurrence skipped (session busy) (${ms}ms)`);
      else log.error(`[schedule] ${label} refused (${ms}ms)${oneLine(end.refused)}`);
      return { fire: "failed" as const, busy: end.busy, failed: end.refused, ms };
    }
    const { fire, detail } = settled(end.ended);
    if (fire === "completed") log.info(`[schedule] ${label} completed (${ms}ms)`);
    else log.error(`[schedule] ${label} ${fire} (${ms}ms)${oneLine(detail ?? "")}`);
    return { fire, busy: false, failed: fire === "completed" ? undefined : detail, ms };
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

/**
 * The claims this process is firing now. A newest claim with no outcome is a dead process's to account for only when no
 * fire of this one holds it: the resident clock and a fire on demand (`schedules.run`) share a process.
 */
const firing = new WeakMap<ClockStore, Set<string>>();
const firingOf = (clock: ClockStore): Set<string> => {
  let held = firing.get(clock);
  if (held === undefined) {
    held = new Set();
    firing.set(clock, held);
  }
  return held;
};
const firingKey = (name: string, slot: Date) => `${name}\0${slot.toISOString()}`;

/** Claim → run → settle one occurrence. */
function fireScheduleOnce(opts: {
  agent: ScheduledAgent;
  clock: ClockStore;
  schedule: Schedule;
  /** The instant this fire is FOR. Two schedulers agree on it, which is what makes the claim exclude. */
  slot: Date;
  now?: () => Date;
  /** Hears the fire's message once it is recorded. */
  accepted?: (message: Message) => void;
}): Effect.Effect<ScheduleFireOutcome, PromiseFailure> {
  return Effect.acquireUseRelease(
    // Counted until its message is accepted (or this fire exits without sending one), so `busy()` has no gap.
    Effect.sync(beginWork),
    (done) =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const { clock: store, schedule: s, slot, now = () => new Date(clock.currentTimeMillisUnsafe()) } = opts;
        const firedAt = now();
        const skippedReason = yield* Effect.tryPromise({
          try: async () => {
            // The DECISION to fire is the claim, and it is atomic: the resident clock and a fire on demand take the same
            // slot, and exactly one of them runs it. It is also the ONLY state write on this path, so a state failure
            // cannot burn a slot that was already claimed.
            const claim = await claimSlot(store, s.name, slot, firedAt);
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
          catch: (cause) => new PromiseFailure(cause),
        });
        if (skippedReason !== undefined) return { fired: false, skippedReason, ms: 0 };
        const held = firingKey(s.name, slot);
        firingOf(store).add(held);
        const withHandoff = {
          ...opts,
          accepted: (message: Message) => {
            done();
            opts.accepted?.(message);
          },
        };
        return yield* firedClaim(withHandoff).pipe(Effect.ensuring(Effect.sync(() => firingOf(store).delete(held))));
      }),
    (done) => Effect.sync(done),
  ).pipe(Effect.uninterruptible);
}

/** A claimed occurrence, run: its session and prompt, its message, and its outcome written back into the claim. */
function firedClaim(opts: {
  agent: ScheduledAgent;
  clock: ClockStore;
  schedule: Schedule;
  slot: Date;
  accepted?: (message: Message) => void;
}): Effect.Effect<ScheduleFireOutcome, PromiseFailure> {
  return Effect.gen(function* () {
    const { agent, clock, schedule: s, slot } = opts;
    // Before anything is sent: the session it continues (created and recorded the first time), and its prompt.
    const prepared = yield* Effect.tryPromise({
      try: async () => ({
        sessionId: await scheduleSessions(clock).of(s.name, agent),
        text: typeof s.prompt === "string" ? s.prompt : await s.prompt({ at: slot }),
      }),
      catch: (cause) => new PromiseFailure(cause),
    }).pipe(Effect.result);
    if (Result.isFailure(prepared)) {
      const failed = `could not prepare the fire: ${String(prepared.failure.cause)}`;
      log.error(`[schedule] ${s.name} failed${oneLine(failed)}`);
      yield* Effect.promise(() => settleClaim(clock, s.name, slot, "failed", 0));
      return { fired: true, failed, ms: 0 };
    }
    // An occurrence on a busy session is refused, and so skipped; its key is the instant, so one occurrence is one run.
    const r = yield* runTurn(
      agent,
      s.name,
      {
        sessionId: prepared.success.sessionId,
        content: [{ type: "text", text: prepared.success.text }],
        whenBusy: "reject",
        idempotencyKey: slot.toISOString(),
      },
      opts.accepted,
    );
    // OVERLAP IS NOT FAILURE. The claim still stands — this occurrence is decided and will not be retried — but
    // what decided it was the previous turn still holding the schedule's session, which is the policy every scheduler
    // names (k8s `concurrencyPolicy: Forbid`, Temporal's `Skip`) and none of them reports as an error.
    if (r.busy) {
      yield* Effect.promise(() => settleClaim(clock, s.name, slot, "skipped", r.ms));
      return {
        fired: false,
        skippedReason: `the previous turn of "${s.name}" is still running — this occurrence is skipped, the next fires per cron`,
        skipped: true as const,
        ms: r.ms,
      };
    }
    yield* Effect.promise(() => settleClaim(clock, s.name, slot, r.fire, r.ms));
    return { fired: true, ...(r.failed === undefined ? {} : { failed: r.failed }), ms: r.ms };
  }).pipe(Effect.uninterruptible);
}

/**
 * Fire `schedule` once, now, outside its clock (`schedules.run`), the way its clock would: a newest claim no
 * fire reported is accounted for first, as a boot does, then this instant is the slot, claimed and settled as any.
 */
export function fireScheduleNow(opts: {
  agent: ScheduledAgent;
  clock: ClockStore;
  schedule: Schedule;
  /** Hears the fire's message once it is recorded. */
  accepted?: (message: Message) => void;
}): Effect.Effect<ScheduleFireOutcome & { slot: Date }, PromiseFailure> {
  return Effect.gen(function* () {
    const { agent, clock, schedule, accepted } = opts;
    const fire = yield* Effect.tryPromise({
      try: () => latestFire(clock, schedule.name),
      catch: (cause) => new PromiseFailure(cause),
    });
    if (
      fire !== undefined &&
      fire.outcome === undefined &&
      !firingOf(clock).has(firingKey(schedule.name, new Date(fire.slot)))
    ) {
      yield* accountForUnreportedFire(agent, clock, schedule.name, fire);
    }
    const slot = new Date((yield* Clock.Clock).currentTimeMillisUnsafe());
    return {
      slot,
      ...(yield* fireScheduleOnce({ agent, clock, schedule, slot, ...(accepted ? { accepted } : {}) })),
    };
  });
}

/**
 * Account for a claim whose fire never reported: the slot is claimed BEFORE its message is sent, and shutdown does not
 * wait for the message (see `AgentService.close`), so a restart landing mid-fire leaves a claim nothing settled — the
 * exact silence the history exists to prevent. Read once, at the next boot. The claim is the ONE record here: it IS
 * the decision, and the outcome is written back into it.
 *
 * WHAT BECAME OF ITS MESSAGE decides the outcome. One the agent took is durable: it is answered after the restart
 * (or already was), so its end is read through its key and written back, as the fire that ran would have. One that was
 * never taken is `interrupted`, and NOT re-fired: a fire that kills its own process would then replay on every boot.
 * Cron only: a killed wake-up leaves no claim behind (`takeFirstDueWakeup` removes it before its message is sent).
 *
 * THE NEWEST CLAIM ONLY. A schedule's loop runs one fire at a time, so a killed process leaves exactly one claim
 * unsettled — the one it was in. Walking the whole retained window would add nothing a resident process can produce.
 */
function accountForUnreportedFire(
  agent: ScheduledAgent,
  clock: ClockStore,
  name: string,
  fire: Fire,
): Effect.Effect<void, PromiseFailure> {
  return Effect.gen(function* () {
    // `fire.slot` is what `claimSlot` stored, from `toISOString`: the same key back.
    const slot = new Date(fire.slot);
    const key = slot.toISOString();
    const sessionId = yield* Effect.tryPromise({
      try: () => scheduleSessions(clock).get(name),
      catch: (cause) => new PromiseFailure(cause),
    });
    const taken =
      sessionId === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () =>
              agent.messages.get({ sessionId, idempotencyKey: key }).catch((error: unknown) => {
                if (error instanceof AgentError && error.code === "not_found") return undefined;
                throw error;
              }),
            catch: (cause) => new PromiseFailure(cause),
          });
    if (sessionId === undefined || taken === undefined) {
      log.warn(
        `[schedule] ${name}: the fire claimed at ${fire.firedAt} never sent its message — the process stopped ` +
          `before it, and that slot stays skipped (see \`fastagent schedules list\`)`,
      );
      // No duration: this fire was never timed, and the process that could have timed it is gone.
      yield* Effect.promise(() => settleClaim(clock, name, slot, "interrupted"));
      return;
    }
    log.info(`[schedule] ${name}: the fire claimed at ${fire.firedAt} was taken before a restart — reading its end`);
    const end = yield* Effect.tryPromise({
      try: (signal) => untilEnded(agent, { sessionId, idempotencyKey: key }, signal),
      catch: (cause) => new PromiseFailure(cause),
    });
    if (!("ended" in end)) {
      // Unsettled still, so the next boot reads it again.
      log.warn(
        `[schedule] ${name}: the end of the fire claimed at ${fire.firedAt} is not known yet${oneLine("refused" in end ? end.refused : end.unfinished)}`,
      );
      return;
    }
    const { fire: outcome, detail } = settled(end.ended);
    if (outcome === "completed") log.info(`[schedule] ${name}: the fire claimed at ${fire.firedAt} completed`);
    else log.error(`[schedule] ${name}: the fire claimed at ${fire.firedAt} ${outcome}${oneLine(detail ?? "")}`);
    // No duration either: only its end was seen here.
    yield* Effect.promise(() => settleClaim(clock, name, slot, outcome));
  });
}

/** Which session each schedule continues: one per schedule, so the agent sees what its earlier runs did. */
export function scheduleSessions(clock: ClockStore) {
  return conversationSessions({
    read: () => clock.stored.sessions(),
    record: (name, sessionId) =>
      clock.sessions((current) => ({ next: { ...current, [name]: sessionId }, result: undefined })),
    where: "the instance's storage",
  });
}

/**
 * Stamp when each schedule with no recorded fire was first armed (`since`), and drop names no longer in `schedules`.
 * Writes nothing when nothing changed, so an instance with no schedules creates no document.
 */
async function recordArmed(
  store: ClockStore,
  schedules: readonly Schedule[],
  lastFires: ReadonlyMap<string, string>,
  since: Date,
): Promise<Readonly<Record<string, string>>> {
  const current = await store.stored.armed();
  const names = new Set(schedules.map((s) => s.name));
  const at = since.toISOString();
  const plan = (armed: Readonly<Record<string, string>>): Record<string, string> | undefined => {
    let changed = false;
    const next: Record<string, string> = {};
    for (const [name, when] of Object.entries(armed)) {
      if (!names.has(name) || lastFires.has(name)) {
        changed = true;
        continue;
      }
      if (at < when) {
        next[name] = at;
        changed = true;
      } else {
        next[name] = when;
      }
    }
    for (const s of schedules) {
      if (lastFires.has(s.name) || next[s.name] !== undefined) continue;
      next[s.name] = at;
      changed = true;
    }
    return changed ? next : undefined;
  };
  if (plan(current) === undefined) return current;
  return store.armed((armed) => {
    const next = plan(armed);
    return next === undefined ? { result: armed } : { next, result: next };
  });
}

function dueFor(
  schedule: Schedule,
  lastFireAt: string | undefined,
  armedAt: string | undefined,
  fallback: Date,
): Date | undefined {
  const anchor = lastFireAt ?? armedAt;
  return nextRun(schedule.cron, schedule.tz, anchor === undefined ? fallback : new Date(anchor));
}

export function createScheduler(options: SchedulerOptions): Effect.Effect<Scheduler> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const context = yield* Effect.context<never>();
    const fork = Effect.runForkWith(context);
    const run = Effect.runPromiseWith(context);
    const { agent, clock: store, schedules, now = () => new Date(clock.currentTimeMillisUnsafe()) } = options;
    const loops = new Set<Fiber.Fiber<unknown, unknown>>();
    let stopped = false;

    const launch = (label: string, work: Effect.Effect<void>): Fiber.Fiber<unknown, unknown> =>
      fork(
        Effect.withFiber((fiber) => {
          // Publish ownership before a synchronous agent callback can re-enter stop().
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
          yield* fireScheduleOnce({ agent, clock: store, schedule: s, slot: due, now }).pipe(
            Effect.catchTag("PromiseFailure", (error) =>
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
        }
      });

    /** Claim `slot` and admit its message before resolving, while its turn runs to completion in the background. */
    const startDueFire = (s: Schedule, slot: Date) =>
      Effect.acquireUseRelease(
        Effect.sync(beginWork),
        () =>
          Effect.gen(function* () {
            const admitted = yield* Deferred.make<void>();
            const release = () => void Deferred.doneUnsafe(admitted, Effect.void);
            const fire = fireScheduleOnce({
              agent,
              clock: store,
              schedule: s,
              slot,
              now,
              accepted: () => release(),
            }).pipe(
              Effect.catchTag("PromiseFailure", (error) =>
                Effect.sync(() => {
                  log.error(
                    `[schedule] ${s.name}: fire failed (skipping this run, schedule stays armed): ${String(error.cause)}`,
                  );
                }),
              ),
              Effect.ensuring(Effect.sync(release)),
              Effect.uninterruptible,
            );
            launch(s.name, Effect.asVoid(fire));
            yield* Deferred.await(admitted);
          }),
        (done) => Effect.sync(done),
      );

    /** Arm `s` to fire next at `due`, or say it never will. */
    const arm = (s: Schedule, due: Date | undefined): void => {
      if (!due) {
        log.warn(`[schedule] ${s.name}: cron "${s.cron}" will never fire again — not armed`);
        return;
      }
      launch(s.name, cronLoop(s, due));
    };

    /** Stamp armed schedules, catch up every schedule and wake-up due by now, and optionally arm timers. */
    async function catchUpDue(
      lastFires: ReadonlyMap<string, string>,
      sinceOption: Date | undefined,
      shouldArm: boolean,
    ): Promise<void> {
      const current = now();
      const since = sinceOption !== undefined && sinceOption.getTime() < current.getTime() ? sinceOption : current;
      const armed = await recordArmed(store, schedules, lastFires, since);
      for (const s of schedules) {
        if (stopped) break;
        const due = dueFor(s, lastFires.get(s.name), armed[s.name], current);
        if (due && due.getTime() <= current.getTime()) {
          log.info(`[schedule] ${s.name}: catching up a missed run`);
          await run(startDueFire(s, due));
          if (shouldArm && !stopped) {
            arm(s, nextRun(s.cron, s.tz, new Date(Math.max(now().getTime(), due.getTime()))));
          }
          continue;
        }
        if (shouldArm) arm(s, due);
      }
    }

    return {
      async start(startOptions) {
        stopped = false;
        // ONE claim read per schedule — the newest — for reconciliation and catch-up. A read fault stays synchronous
        // before any timers start so a schedule is never run blind.
        const lastFires = new Map<string, string>();
        for (const s of schedules) {
          const fire = await latestFire(store, s.name);
          if (fire === undefined) continue;
          lastFires.set(s.name, fire.firedAt);
          if (fire.outcome !== undefined) continue;
          const accounted = accountForUnreportedFire(agent, store, s.name, fire).pipe(
            Effect.catchTag("PromiseFailure", (error) =>
              Effect.sync(() =>
                log.error(
                  `[schedule] ${s.name}: could not account for the fire claimed at ${fire.firedAt}: ${String(error.cause)}`,
                ),
              ),
            ),
          );
          launch(s.name, accounted);
        }
        await catchUpDue(lastFires, startOptions?.since, true);
      },
      async tick(tickOptions) {
        if (stopped) return;
        const lastFires = new Map<string, string>();
        for (const s of schedules) {
          const fire = await latestFire(store, s.name);
          if (fire !== undefined) lastFires.set(s.name, fire.firedAt);
        }
        await catchUpDue(lastFires, tickOptions?.since, false);
      },
      async nextDue(at = now()) {
        const [armed, fires] = await Promise.all([
          store.stored.armed(),
          Promise.all(schedules.map((s) => latestFire(store, s.name))),
        ]);
        let earliest: number | undefined;
        const consider = (ms: number | undefined) => {
          if (ms !== undefined && (earliest === undefined || ms < earliest)) earliest = ms;
        };
        for (const [i, s] of schedules.entries()) {
          consider(dueFor(s, fires[i]?.firedAt, armed[s.name], at)?.getTime());
        }
        return earliest === undefined ? undefined : new Date(earliest);
      },
      stop() {
        stopped = true;
        for (const loop of loops) loop.interruptUnsafe();
      },
    };
  });
}
