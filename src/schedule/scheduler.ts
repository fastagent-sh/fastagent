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
import type { LoadedSchedule } from "./schedule.ts";
import { claimSlot, type Fire, latestFire, settleClaim } from "./state.ts";
import { deferWakeup, takeFirstDueWakeup, type Wakeup } from "./wakeups.ts";

/** A schedule shares one continuing conversation without depending on engine session storage. */
export function scheduleSession(name: string): string {
  return `schedule:${name}`;
}

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
      `and that slot stays skipped (see \`fastagent schedule history ${name}\`)`,
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

/**
 * How much of a reply the completed line carries. A reply is model output with no natural ceiling — one turn that
 * echoes a file it read is hundreds of kilobytes — and the rotation window it now lives in is finite, so an
 * uncapped line would evict the diagnostics around it: exactly what moving the reply into the log was for.
 * The full text is not promised anywhere; the length is, so a truncated line says what it dropped.
 *
 * This also decides WHO reads the answer: the log's audience, which on a deployment is wider than the state volume's
 * was (docs/design/core.md §8 states the trade and the only lever, `FASTAGENT_LOG_LEVEL`). That trade is made for a
 * CRON fire, whose turn nobody is watching — which is why `runTurn` takes `logReply` rather than doing this for
 * every caller: see the wake-up path.
 */
const REPLY_LOG_LIMIT = 2000;

/**
 * THE tail of every line a turn contributes — its reply, its failure details, its thrown cause — as `: <text>`, or
 * nothing when there is none to add.
 *
 * ONE LINE, ALWAYS. `log.ts` prefixes only the first line, so a newline anywhere in here emits a second line that is
 * byte-for-byte a real record: `ERROR [schedule] daily failed (1ms): DISK ON FIRE` is something a scheduled turn's
 * own reply can produce, and a scheduled turn's reply is untrusted by construction ("read the inbox and summarise").
 * Collapsing whitespace also keeps the line-oriented consumers this design leans on — `docker logs`, journald,
 * CloudWatch — reading one fire as one event.
 *
 * Capped for the same reason as the reply: this text lives in a finite rotation window, and a failure detail
 * carrying a whole stack would evict the diagnostics around it.
 */
function turnDetail(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one === "") return "";
  if (one.length <= REPLY_LOG_LIMIT) return `: ${one}`;
  const cut = one.slice(0, REPLY_LOG_LIMIT);
  // The limit counts UTF-16 units, so it can land inside a surrogate pair and log half an emoji as \uFFFD. Dropping
  // a trailing high surrogate is the whole fix; `channels/kit/text.ts`'s `codePointPrefix` is the same idea, but the
  // kit is importable only from `channels/<platform>/` (package-boundary.test.ts) and this is one line.
  const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `: ${safe}… (${one.length} chars)`;
}

/**
 * The iterator is a Promise port inside an uninterruptible claimed occurrence, including its cleanup.
 *
 * `logReply` is not a preference: a CRON fire runs unattended in its own `schedule:<name>` session, so the log is the
 * only place its answer is ever seen. A WAKE-UP runs in the session that asked for it — a Telegram group, a Feishu
 * thread, a Slack channel — where a human reads the answer in the conversation itself. Copying that into the
 * operator's log buys no diagnosis and moves private conversation content into a wider audience.
 */
function runTurn(agent: Agent, label: string, session: string, prompt: string, logReply: boolean) {
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
          if (result.failed) log.error(`[schedule] ${label} failed (${elapsed()}ms)${turnDetail(result.failed)}`);
          // The reply goes to the LOG, not to disk: it is the turn's narrative, and rotating a narrative is the
          // platform's job (12-factor XI): a log has a layer whose job is to bound it — a platform's shipper, or
          // the `logging:` block `deploy docker` generates — and a file we append to forever does not.
          else log.info(`[schedule] ${label} completed (${elapsed()}ms)${logReply ? turnDetail(result.reply) : ""}`);
          return { ...result, ms: elapsed() };
        },
        onFailure: (error) => {
          // An iterator throw violates SPEC MUST 2 and is never a replay-safe busy rejection.
          log.error(`[schedule] ${label} errored (${elapsed()}ms)${turnDetail(String(error.cause))}`);
          return { busy: false, failed: String(error.cause), reply: "", ms: elapsed() };
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
  ms: number;
}

/** Shared resident/external claim → run → settle. */
export function fireScheduleOnce(opts: {
  agent: Agent;
  stateRoot: string;
  schedule: LoadedSchedule;
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
    // Default true: an unattended turn's answer is seen by nobody otherwise. An author turns it off per schedule
    // (`defineSchedule({ logReply: false })`) when that answer is the sensitive part.
    const r = yield* runTurn(agent, s.name, scheduleSession(s.name), s.prompt, s.logReply ?? true);
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
            // No reply in the log: this turn's answer belongs to the conversation that scheduled it (see `runTurn`).
            const r = yield* runTurn(agent, label, w.session, wakeEnvelope(w), false);
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

    return {
      start() {
        stopped = false;
        // ONE claim read per schedule — the newest — for the two planes that must agree about it: the reconciler
        // (was that fire ever reported?) and catch-up (where does the next run resume?). A read fault on it stays
        // synchronous, before any timers or turns are started: a schedule whose newest claim cannot be read is not
        // one to run blind, it is a boot failure. The rest of the window is history, and history does not gate a
        // boot (`latestFire`).
        const lastFires = new Map<string, string>();
        if (!externalClock) {
          for (const s of schedules) {
            const fire = latestFire(stateRoot, s.name);
            if (fire !== undefined) lastFires.set(s.name, fire.firedAt);
            markInterruptedFire(stateRoot, s.name, fire);
          }
        }
        const current = now();
        for (const s of externalClock ? [] : schedules) {
          if (stopped) break;
          const last = lastFires.get(s.name);
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
