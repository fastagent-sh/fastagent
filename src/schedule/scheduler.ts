/** Resident cron and wake polling. */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import { join } from "node:path";
import type { Agent, InvokeRequest, Outcome } from "../agent-api.ts";
import { conversationSessions } from "../conversation-sessions.ts";
import { PortFailure } from "../effect-port.ts";
import { beginWork } from "../channels/busy.ts";
import { log } from "../log.ts";
import { nextRun } from "./cron.ts";
import type { Schedule } from "./schedule.ts";
import { claimSlot, type Fire, latestFire, settleClaim } from "./state.ts";
import { requeueWakeup, takeFirstDueWakeup, type Wakeup } from "./wakeups.ts";

export interface Scheduler {
  /** Arm schedules, account for a fire the previous run was killed in, and catch up overdue work once. */
  start(): void;
  /** Cancel pending waits. */
  stop(): void;
}

/** All the scheduler asks of the agent. */
export type ScheduledAgent = Pick<Agent, "invoke" | "createSession" | "getMessage" | "read">;

export interface SchedulerOptions {
  agent: ScheduledAgent;
  stateRoot: string;
  /** The definition's schedules. */
  schedules: readonly Schedule[];
  /**
   * Run a resident timer per schedule (default). Off where something outside the process delivers each instant as
   * its own fire (AgentCore's recurring EventBridge schedules): one path per instant, so its delivery's reply says
   * whether it ran.
   */
  localClock?: boolean;
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
 * How one invoke went: refused before it ran (or not known to be taken), the message's outcome, or a wait that ended
 * before its message did, with why.
 */
type InvokeEnd = { refused: string; busy: boolean } | { outcome: Outcome } | { unfinished: string };

/**
 * Send one message and wait for its end; `onAccepted` hears the receipt. Interrupted, it stops waiting, and the agent
 * goes on: a Caller that stops waiting only detaches (agent-api.md §3.1).
 */
async function readInvoke(
  agent: ScheduledAgent,
  request: InvokeRequest,
  onAccepted: () => void,
  signal: AbortSignal,
): Promise<InvokeEnd> {
  const receipt = await agent.invoke(request);
  if (!receipt.ok) {
    return "error" in receipt
      ? { refused: receipt.error.message, busy: receipt.error.code === "busy" }
      : { unfinished: `whether the message was taken is not known: ${receipt.unknown.reason}` };
  }
  onAccepted();
  const end = await receipt.wait({ signal });
  return end.ok ? { outcome: end.message.outcome } : { unfinished: end.unfinished.reason };
}

/** A message's outcome as the one word a claim keeps, and the detail worth a log line. */
function settled(outcome: Outcome): { fire: "completed" | "failed"; detail?: string } {
  switch (outcome.status) {
    case "completed":
    case "max_tokens":
      return { fire: "completed" };
    case "canceled":
      return { fire: "failed", detail: "canceled" };
    case "failed":
      return { fire: "failed", detail: outcome.error.message };
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
function runTurn(agent: ScheduledAgent, label: string, request: InvokeRequest, onAccepted: () => void = () => {}) {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const startedAt = clock.currentTimeMillisUnsafe();
    const elapsed = () => clock.currentTimeMillisUnsafe() - startedAt;
    log.info(`[schedule] ${label} firing (session=${request.sessionId})`);
    const read = yield* Effect.tryPromise({
      try: (signal) => readInvoke(agent, request, onAccepted, signal),
      catch: (cause) => new PortFailure(cause),
    }).pipe(Effect.result);
    const ms = elapsed();
    if (Result.isFailure(read)) {
      // A call that throws breaks the API (failures are values), so it is this fire's failure, never a refusal.
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
    const { fire, detail } = settled(end.outcome);
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

/** Shared resident/external claim → run → settle. */
export function fireScheduleOnce(opts: {
  agent: ScheduledAgent;
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
    // Before anything is sent: the session it continues (created and recorded the first time), and its prompt.
    const prepared = yield* Effect.tryPromise({
      try: async () => ({
        sessionId: await scheduleSessions(stateRoot).of(s.name, agent),
        text: typeof s.prompt === "string" ? s.prompt : await s.prompt({ at: slot }),
      }),
      catch: (cause) => new PortFailure(cause),
    }).pipe(Effect.result);
    if (Result.isFailure(prepared)) {
      const failed = `could not prepare the fire: ${String(prepared.failure.cause)}`;
      log.error(`[schedule] ${s.name} failed${oneLine(failed)}`);
      settleClaim(stateRoot, s.name, slot, "failed", 0);
      return { fired: true, failed, ms: 0 };
    }
    // An occurrence on a busy session is refused, and so skipped; its key is the instant, so one occurrence is one run.
    const r = yield* runTurn(agent, s.name, {
      sessionId: prepared.success.sessionId,
      content: [{ type: "text", text: prepared.success.text }],
      whenBusy: "reject",
      idempotencyKey: slot.toISOString(),
    });
    // OVERLAP IS NOT FAILURE. The claim still stands — this occurrence is decided and will not be retried — but
    // what decided it was the previous turn still holding the schedule's session, which is the policy every scheduler
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
    settleClaim(stateRoot, s.name, slot, r.fire, r.ms);
    return { fired: true, ...(r.failed === undefined ? {} : { failed: r.failed }), ms: r.ms };
  }).pipe(Effect.uninterruptible);
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
  stateRoot: string,
  name: string,
  fire: Fire,
): Effect.Effect<void, PortFailure> {
  return Effect.gen(function* () {
    // `fire.slot` came from a claim file name, which `listClaims` admits only when it round-trips through this same
    // conversion — so the Date is valid and `settleClaim` writes back the file it was read from.
    const slot = new Date(fire.slot);
    const key = slot.toISOString();
    const sessionId = scheduleSessions(stateRoot).get(name);
    const taken =
      sessionId === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => agent.getMessage(sessionId, { idempotencyKey: key }),
            catch: (cause) => new PortFailure(cause),
          });
    if (sessionId === undefined || taken === undefined) {
      log.warn(
        `[schedule] ${name}: the fire claimed at ${fire.firedAt} never sent its message — the process stopped ` +
          `before it, and that slot stays skipped (see \`fastagent schedules list\`)`,
      );
      // No duration: this fire was never timed, and the process that could have timed it is gone.
      settleClaim(stateRoot, name, slot, "interrupted");
      return;
    }
    log.info(`[schedule] ${name}: the fire claimed at ${fire.firedAt} was taken before a restart — reading its end`);
    // The key alone names the message, so this sends nothing: its receipt is the one the fire had (agent-api.md §3.3).
    const request: InvokeRequest = {
      sessionId,
      content: [{ type: "text", text: "(the scheduled message this key names)" }],
      idempotencyKey: key,
    };
    const end = yield* Effect.tryPromise({
      try: (signal) => readInvoke(agent, request, () => {}, signal),
      catch: (cause) => new PortFailure(cause),
    });
    if (!("outcome" in end)) {
      // Unsettled still, so the next boot reads it again.
      log.warn(
        `[schedule] ${name}: the end of the fire claimed at ${fire.firedAt} is not known yet${oneLine("refused" in end ? end.refused : end.unfinished)}`,
      );
      return;
    }
    const { fire: outcome, detail } = settled(end.outcome);
    if (outcome === "completed") log.info(`[schedule] ${name}: the fire claimed at ${fire.firedAt} completed`);
    else log.error(`[schedule] ${name}: the fire claimed at ${fire.firedAt} ${outcome}${oneLine(detail ?? "")}`);
    // No duration either: only its end was seen here.
    settleClaim(stateRoot, name, slot, outcome);
  });
}

/** Which session each schedule continues: one per schedule, so the agent sees what its earlier runs did. */
export function scheduleSessions(stateRoot: string) {
  return conversationSessions(join(stateRoot, "schedule", "sessions.json"));
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
      localClock = true,
      now = () => new Date(clock.currentTimeMillisUnsafe()),
    } = options;
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
        }
      });

    /**
     * Fire the first due wake-up into its session, queued behind whatever runs there. The wake-up is taken out of the
     * store first, so accepted is delivered: the pump goes on to the next one, and how the message ends is followed
     * apart.
     */
    const wakeOnce = Effect.gen(function* () {
      const w = yield* Effect.try({
        try: () => takeFirstDueWakeup(stateRoot, now()),
        catch: (cause) => new PortFailure(cause),
      });
      if (!w) return false;
      const label = `wake ${w.id.slice(0, 8)}`;
      const request: InvokeRequest = {
        sessionId: w.session,
        content: [{ type: "text", text: wakeEnvelope(w) }],
        whenBusy: "queue",
        idempotencyKey: `wake:${w.id}@${w.fireAt}`,
      };
      // Counted until the message is accepted: from then on the message itself is the work in flight.
      yield* Effect.acquireUseRelease(
        Effect.sync(beginWork),
        () =>
          Effect.gen(function* () {
            const accepted = yield* Deferred.make<void>();
            const delivered = () => void Deferred.doneUnsafe(accepted, Effect.void);
            const followed = runTurn(agent, label, request, delivered).pipe(
              Effect.tap((r) =>
                // Queued, it is refused only while the process or its session's queue is full: for now. A recurring
                // wake-up has its next occurrence; a one-shot one goes back in the store, for the next poll.
                r.busy && w.cron === undefined
                  ? Effect.try({
                      try: () => {
                        requeueWakeup(stateRoot, w, new Date(now().getTime() + WAKEUP_POLL_MS));
                        log.info(`[schedule] ${label}: refused for now — retrying next poll (${r.failed})`);
                      },
                      catch: (cause) => new PortFailure(cause),
                    }).pipe(
                      Effect.catchTag("PortFailure", (error) =>
                        Effect.sync(() =>
                          log.error(
                            `[schedule] ${label}: refused, and could not be kept for a retry, so it is gone: ${String(error.cause)}`,
                          ),
                        ),
                      ),
                    )
                  : Effect.void,
              ),
              Effect.ensuring(Effect.sync(delivered)),
            );
            launch(label, Effect.asVoid(followed));
            yield* Deferred.await(accepted);
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

    /** Arm `s` to fire next at `due`, or say it never will. */
    const arm = (s: Schedule, due: Date | undefined): void => {
      if (!localClock) return;
      if (!due) {
        log.warn(`[schedule] ${s.name}: cron "${s.cron}" will never fire again — not armed`);
        return;
      }
      launch(s.name, cronLoop(s, due));
    };

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
          if (fire === undefined) continue;
          lastFires.set(s.name, fire.firedAt);
          if (fire.outcome !== undefined) continue;
          const accounted = accountForUnreportedFire(agent, stateRoot, s.name, fire).pipe(
            Effect.catchTag("PortFailure", (error) =>
              Effect.sync(() =>
                // Unsettled still, so the next boot reads it again.
                log.error(
                  `[schedule] ${s.name}: could not account for the fire claimed at ${fire.firedAt}: ${String(error.cause)}`,
                ),
              ),
            ),
          );
          launch(s.name, accounted);
        }
        const current = now();
        for (const s of schedules) {
          if (stopped) break;
          // FROM THE LAST FIRE, or from now when there was none. A schedule that has never fired does not catch
          // up the occurrence it missed while the process was down: nothing recorded that it was ever armed then,
          // so "missed" is not a fact this process has. Every boot after the first resumes from the claim.
          const last = lastFires.get(s.name);
          const due = nextRun(s.cron, s.tz, last ? new Date(last) : current);
          if (localClock && due && due.getTime() <= current.getTime()) {
            log.info(`[schedule] ${s.name}: catching up a missed run`);
          }
          arm(s, due);
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
