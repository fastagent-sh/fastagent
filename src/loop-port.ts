/**
 * `LoopPort`: the harness port for a harness that is only a loop (docs/design/agent-service.md §9.1, §9.3). It owns
 * what such a harness lacks: admission, the queue, idempotency, run records, the steering promise and closing
 * interrupted runs.
 *
 * Run records are entries in the session's own log, written through its one writer: `run_accepted` (a plane marker,
 * never published), `run_started` and `run_ended` (published). A session's log is held from the first operation that
 * acquires it until the session is idle and nothing holds it; every operation acquires it, so a session has one
 * writer, and the first acquisition in a process closes the runs a previous process left open.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { PortFailure, port } from "./effect-port.ts";
import type { Admission, HarnessPort, Page, PortRead } from "./harness-port.ts";
import { log as logger } from "./log.ts";
import {
  type AbortResult,
  type AgentCommand,
  type Attachment,
  type Capabilities,
  type Entry,
  type Json,
  LIMITS,
  type LiveEvent,
  type ModelDescriptor,
  type Prompt,
  type Result,
  type RunKey,
  type RunMessage,
  type RunOutcome,
  type RunSource,
  type RunStatus,
  type SessionEvent,
  type SessionSettings,
  type SessionState,
  type SessionSummary,
  type Usage,
  type WhenBusy,
  agentError,
  failure,
} from "./protocol.ts";

/** One record of a session's log: the harness's entries and `LoopPort`'s run markers alike. */
export interface LogRecord {
  id: string;
  parentEntryId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}

export type RunMarker = "run_accepted" | "run_started" | "run_ended";

type LoopOutcome = Extract<RunOutcome, { status: "completed" | "max_tokens" | "intercepted" | "failed" }>;

type Distribute<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type LoopLiveEvent = Distribute<LiveEvent, "runId">;

export interface LoopRun {
  /**
   * Hand a message to the run, which takes it after its current tool round and writes it as a `user_message`. A message
   * the run ended without writing is run by `LoopPort` itself, in the same run: it counts the entries, so a harness
   * that misses one (pi's `steer()` can queue after its run settled) cannot drop it.
   */
  steer(message: Prompt): Promise<void>;
  stop(): void;
  readonly done: Promise<{ outcome: LoopOutcome; usage?: Usage }>;
}

/** A session's log, opened for writing. `LoopPort` holds at most one per session at a time. */
export interface LoopLog {
  /** Every record, in append order. */
  records(): readonly LogRecord[];
  /** Durable when it returns; reported to `onRecord` like every other append. */
  append(kind: RunMarker, data: Json): LogRecord;
  state(): Omit<SessionState, "status" | "run" | "queued">;
  /** Start a run on this log. The harness writes the message as a `user_message` entry when it takes it. */
  run(message: Prompt, emit: (event: LoopLiveEvent) => void): LoopRun;
  rewind(entryId: string): Promise<Result>;
  compact(options: { instructions?: string }, signal: AbortSignal): Promise<Result>;
  update(settings: SessionSettings): Promise<Result>;
  attachment(ref: string): Promise<Attachment | undefined>;
  close(): void;
}

export interface LoopHarness {
  readonly capabilities: Omit<Capabilities, "durableQueue" | "durableRuns">;
  /** `onRecord` sees every record appended from now on, by the harness or by `LoopPort`, once it is durable. */
  open(sessionId: string, onRecord: (record: LogRecord) => void): Promise<LoopLog | undefined>;
  /** A fork copies the source's conversation up to `entryId`, never its run markers: runs are not copied. */
  create(
    sessionId: string,
    onRecord: (record: LogRecord) => void,
    fork?: { from: LoopLog; entryId?: string },
  ): Promise<LoopLog>;
  /** Called with the session's log closed. */
  delete(sessionId: string): Promise<void>;
  list(): Promise<SessionSummary[]>;
  models(): Promise<ModelDescriptor[]>;
  commands(): Promise<AgentCommand[]>;
}

export interface LoopPortLimits {
  queuedPerSession: number;
  inFlightPerProcess: number;
}

type AcceptedData = { runId: string; idempotencyKey?: string; source: RunSource; joined?: true };
type EndedData = { runId: string; outcome: RunOutcome; usage?: Usage };

interface Queued {
  readonly runId: string;
  readonly message: Prompt;
  readonly idempotencyKey?: string;
  readonly source: RunSource;
  /** Holds the session while the run is queued or running. */
  readonly hold: Scope.Closeable;
}

interface Running extends Queued {
  readonly startedAt: number;
  readonly ended: Deferred.Deferred<void>;
  loop: LoopRun;
  stoppedBy?: "cancel" | "abort" | "delete";
  /** Set once the run has decided to end: a message arriving after it starts a run of its own. */
  closing: boolean;
  readonly steering: Set<Promise<void>>;
  /** The message that started the run, then each one joined, in the order they were accepted. */
  readonly messages: Prompt[];
}

interface Held {
  readonly sessionId: string;
  readonly lock: Semaphore.Semaphore;
  log: LoopLog | undefined;
  /** The run whose `run_started` opened the current span of the log. */
  span: string | undefined;
  readonly keys: Map<string, string>;
  readonly queue: Queued[];
  running: Running | undefined;
  compaction: { readonly controller: AbortController; readonly done: Deferred.Deferred<void> } | undefined;
}

const markerRunId = (record: LogRecord): string => (record.data as { runId: string }).runId;

/**
 * Where a record sits among runs, and whether it is published: one rule for the live path and for every read. A
 * marker names its run; `settings_changed` belongs to none; anything else belongs to the run whose span encloses it.
 */
function place(
  span: string | undefined,
  record: LogRecord,
): { published: boolean; runId?: string; span: string | undefined } {
  switch (record.kind) {
    case "run_accepted":
      return { published: false, span };
    case "run_started": {
      const runId = markerRunId(record);
      return { published: true, runId, span: runId };
    }
    case "run_ended": {
      const runId = markerRunId(record);
      return { published: true, runId, span: span === runId ? undefined : span };
    }
    case "settings_changed":
      return { published: true, span };
    default:
      return span === undefined ? { published: true, span } : { published: true, runId: span, span };
  }
}

function toEntry(record: LogRecord, runId: string | undefined): Entry {
  return runId === undefined ? { ...record } : { ...record, runId };
}

function published(records: readonly LogRecord[]): { entries: Entry[]; span: string | undefined } {
  const entries: Entry[] = [];
  let span: string | undefined;
  for (const record of records) {
    const placed = place(span, record);
    span = placed.span;
    if (placed.published) entries.push(toEntry(record, placed.runId));
  }
  return { entries, span };
}

function addUsage(total: Usage | undefined, more: Usage | undefined): Usage | undefined {
  if (!more) return total;
  if (!total) return more;
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const optional = (key: "cacheReadTokens" | "cacheWriteTokens" | "cost") => {
    const value = sum(total[key], more[key]);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    inputTokens: total.inputTokens + more.inputTokens,
    outputTokens: total.outputTokens + more.outputTokens,
    ...optional("cacheReadTokens"),
    ...optional("cacheWriteTokens"),
    ...optional("cost"),
  };
}

/** A harness that throws instead of starting a run gets a run that failed, so the run still ends once. */
function failedRun(error: unknown): LoopRun {
  const message = error instanceof Error ? error.message : String(error);
  return {
    steer: async () => {},
    stop: () => {},
    done: Promise.resolve({ outcome: { status: "failed", error: agentError("internal", message) } }),
  };
}

const NOT_STARTED = failedRun("the run has not started");

const PREVIEW_CHARS = 80;

export function loopPort(
  harness: LoopHarness,
  limits: LoopPortLimits = {
    queuedPerSession: LIMITS.queuedPerSession,
    inFlightPerProcess: LIMITS.inFlightPerProcess,
  },
): HarnessPort {
  const capabilities: Capabilities = { ...harness.capabilities, durableQueue: false, durableRuns: false };
  const listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  const active = new Map<string, Held>();
  let inFlight = 0;

  const emit = (sessionId: string, event: SessionEvent): void => {
    for (const listener of listeners.get(sessionId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        logger.warn(`[fastagent] session listener threw (session ${sessionId}, event ${event.type}): ${String(error)}`);
      }
    }
  };

  const stateOf = (held: Held, log: LoopLog): SessionState => ({
    ...log.state(),
    status: held.running ? "running" : held.compaction ? "compacting" : "idle",
    ...(held.running ? { run: { runId: held.running.runId, startedAt: held.running.startedAt } } : {}),
    queued: held.queue.map((queued) => ({
      runId: queued.runId,
      ...(queued.idempotencyKey === undefined ? {} : { idempotencyKey: queued.idempotencyKey }),
      preview: queued.message.text.slice(0, PREVIEW_CHARS),
    })),
  });

  const emitState = (held: Held): void => {
    if (held.log && listeners.has(held.sessionId)) {
      emit(held.sessionId, { type: "state", state: stateOf(held, held.log) });
    }
  };

  const onRecord =
    (held: Held) =>
    (record: LogRecord): void => {
      const placed = place(held.span, record);
      held.span = placed.span;
      if (!placed.published) return;
      emit(held.sessionId, { type: "entry", entry: toEntry(record, placed.runId) });
    };

  /** Close the runs a previous process left open, and index the keys. Runs before anything else on the session. */
  const reconcile = (held: Held, log: LoopLog): void => {
    const records = log.records();
    held.span = published(records).span;
    const ended = new Set(records.filter((r) => r.kind === "run_ended").map(markerRunId));
    const open: string[] = [];
    for (const record of records) {
      if (record.kind !== "run_accepted") continue;
      const data = record.data as AcceptedData;
      if (data.idempotencyKey !== undefined) held.keys.set(data.idempotencyKey, data.runId);
      if (!data.joined && !ended.has(data.runId)) open.push(data.runId);
    }
    for (const runId of open)
      log.append("run_ended", { runId, outcome: { status: "interrupted" } } satisfies EndedData);
  };

  const sessions = Effect.runSync(
    Scope.provide(
      RcMap.make({
        lookup: (sessionId: string) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const held: Held = {
                sessionId,
                lock: Semaphore.makeUnsafe(1),
                log: undefined,
                span: undefined,
                keys: new Map(),
                queue: [],
                running: undefined,
                compaction: undefined,
              };
              const log = yield* port(() => harness.open(sessionId, onRecord(held)));
              if (log) {
                // The release below never runs for an acquisition that failed, so a log reconcile could not close is
                // closed here.
                yield* Effect.try({ try: () => reconcile(held, log), catch: (cause) => new PortFailure(cause) }).pipe(
                  Effect.onError(() => Effect.sync(() => log.close())),
                );
              }
              held.log = log;
              active.set(sessionId, held);
              return held;
            }),
            (held) =>
              Effect.sync(() => {
                active.delete(held.sessionId);
                held.log?.close();
              }),
          ),
      }),
      Scope.makeUnsafe(),
    ),
  );

  const use = <A, E>(sessionId: string, work: (held: Held) => Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(RcMap.get(sessions, sessionId), work)));

  const locked = <A, E, R>(held: Held, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Semaphore.withPermits(held.lock, 1)(work);

  /** A run's status, for the run plane and every read alike: memory says queued or running, the log says the rest. */
  const statusOf = (held: Held, log: LoopLog, runId: string): RunStatus | undefined => {
    const records = log.records();
    const accepted = records
      .filter((r) => r.kind === "run_accepted" && markerRunId(r) === runId)
      .map((r) => r.data as AcceptedData);
    const first = accepted[0];
    if (!first) return undefined;
    const entries = published(records).entries.filter((entry) => entry.runId === runId);
    const userEntries = entries.filter((entry) => entry.kind === "user_message");
    const messages: RunMessage[] = accepted.map((data, i) => ({
      ...(userEntries[i] ? { entryId: userEntries[i].id } : {}),
      ...(data.idempotencyKey === undefined ? {} : { idempotencyKey: data.idempotencyKey }),
    }));
    const base = { runId, source: first.source, messages };
    const position = held.queue.findIndex((queued) => queued.runId === runId);
    if (position >= 0) return { ...base, status: "queued", position: position + 1 };
    if (held.running?.runId === runId) return { ...base, status: "running", startedAt: held.running.startedAt };
    const started = entries.find((entry) => entry.kind === "run_started");
    const ended = entries.find((entry) => entry.kind === "run_ended");
    const answer = entries.filter((entry) => entry.kind === "assistant_message").at(-1);
    const endedData = ended?.data as EndedData | undefined;
    return {
      ...base,
      status: "done",
      ...(started ? { startedAt: started.timestamp } : {}),
      endedAt: ended?.timestamp ?? Date.now(),
      // A run neither in memory nor ended is one this process never closed: reconcile closes them on acquisition.
      outcome: endedData?.outcome ?? { status: "interrupted" },
      ...(endedData?.usage ? { usage: endedData.usage } : {}),
      ...(answer
        ? { answer: { entryId: answer.id, text: String((answer.data as { text?: unknown }).text ?? "") } }
        : {}),
    };
  };

  const release = (hold: Scope.Closeable): void => {
    Effect.runFork(Scope.close(hold, Exit.void));
  };

  /**
   * A marker the storage refused. Callers take the run out of memory first, so it reads as `interrupted` (an accepted
   * run with no `run_ended`, neither queued nor running), and the session goes on with the rest of its work. The
   * `serving_error` is what ends a stream waiting for this run's `run_ended`.
   */
  const recorded = (held: Held, log: LoopLog, kind: RunMarker, data: Json, runId: string): boolean => {
    try {
      log.append(kind, data);
      return true;
    } catch (error) {
      const message = `could not record ${kind} of run ${runId}; it reads as interrupted: ${String(error)}`;
      logger.error(`[fastagent] ${message}`);
      emit(held.sessionId, { type: "serving_error", message });
      return false;
    }
  };

  const withdraw = (held: Held, log: LoopLog, queued: Queued, by: "cancel" | "abort" | "delete"): void => {
    held.queue.splice(held.queue.indexOf(queued), 1);
    inFlight--;
    release(queued.hold);
    recorded(
      held,
      log,
      "run_ended",
      { runId: queued.runId, outcome: { status: "canceled", by } } satisfies EndedData,
      queued.runId,
    );
  };

  const stop = (running: Running, by: "cancel" | "abort" | "delete"): void => {
    if (running.stoppedBy) return;
    running.stoppedBy = by;
    running.loop.stop();
  };

  const steerInto = (running: Running, message: Prompt): void => {
    const handed = running.loop.steer(message).catch((error) => {
      logger.error(`[fastagent] steering run ${running.runId} failed; it runs the message itself: ${String(error)}`);
    });
    const tracked = handed.finally(() => running.steering.delete(tracked));
    running.steering.add(tracked);
  };

  /** How many of the run's messages the harness has written: it takes them in order, so the count says which. */
  const takenCount = (log: LoopLog, running: Running): number =>
    published(log.records()).entries.filter((entry) => entry.runId === running.runId && entry.kind === "user_message")
      .length;

  const startLoop = (held: Held, log: LoopLog, runId: string, message: Prompt): LoopRun => {
    try {
      return log.run(message, (event) => emit(held.sessionId, { ...event, runId }));
    } catch (error) {
      logger.error(`[fastagent] the harness could not start run ${runId}: ${String(error)}`);
      return failedRun(error);
    }
  };

  const drive = (held: Held, log: LoopLog, running: Running): Effect.Effect<void> =>
    Effect.gen(function* () {
      let outcome: RunOutcome = { status: "completed" };
      let usage: Usage | undefined;
      let takenBefore = 0;
      for (;;) {
        const result = yield* Effect.exit(port(() => running.loop.done));
        if (Exit.isFailure(result)) {
          logger.error(`[fastagent] run ${running.runId} rejected instead of ending: ${String(result.cause)}`);
          outcome = { status: "failed", error: agentError("internal", "the harness failed the run") };
          break;
        }
        outcome = result.value.outcome;
        usage = addUsage(usage, result.value.usage);
        while (running.steering.size > 0) yield* port(() => Promise.all(running.steering)).pipe(Effect.ignore);
        const taken = takenCount(log, running);
        const [next, ...rest] = running.messages.slice(taken);
        // A loop that ended without writing even its own first message refused it (a failure before the model, an
        // interception): the run ends with that outcome, and the messages it never took end with it.
        if (running.stoppedBy || !next || taken === takenBefore) {
          running.closing = true;
          break;
        }
        takenBefore = taken;
        running.loop = startLoop(held, log, running.runId, next);
        for (const message of rest) steerInto(running, message);
      }
      if (running.stoppedBy) outcome = { status: "canceled", by: running.stoppedBy };
      return { outcome, usage };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          logger.error(`[fastagent] run ${running.runId} failed in LoopPort: ${String(cause)}`);
          return {
            outcome: { status: "failed", error: agentError("internal", "the run failed") } as RunOutcome,
            usage: undefined,
          };
        }),
      ),
      Effect.flatMap(({ outcome, usage }) =>
        Effect.sync(() => {
          held.running = undefined;
          recorded(
            held,
            log,
            "run_ended",
            { runId: running.runId, outcome, ...(usage ? { usage } : {}) } satisfies EndedData,
            running.runId,
          );
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          held.running = undefined;
          inFlight--;
          yield* Deferred.succeed(running.ended, undefined);
          pump(held);
          emitState(held);
          yield* Scope.close(running.hold, Exit.void);
        }),
      ),
    );

  const pump = (held: Held): void => {
    const log = held.log;
    if (!log || held.running || held.compaction) return;
    const next = held.queue.shift();
    if (!next) return;
    const running: Running = {
      ...next,
      startedAt: Date.now(),
      ended: Deferred.makeUnsafe<void>(),
      loop: NOT_STARTED,
      closing: false,
      steering: new Set(),
      messages: [next.message],
    };
    if (!recorded(held, log, "run_started", { runId: running.runId }, running.runId)) {
      inFlight--;
      release(next.hold);
      pump(held);
      return;
    }
    held.running = running;
    running.loop = startLoop(held, log, running.runId, running.message);
    Effect.runFork(drive(held, log, running));
  };

  const accept = (
    held: Held,
    log: LoopLog,
    message: Prompt,
    options: { whenBusy: WhenBusy; idempotencyKey?: string; source: RunSource },
  ): Effect.Effect<Admission, PortFailure, Scope.Scope> =>
    Effect.gen(function* () {
      const { whenBusy, idempotencyKey, source } = options;
      if (idempotencyKey !== undefined) {
        const known = held.keys.get(idempotencyKey);
        const run = known === undefined ? undefined : statusOf(held, log, known);
        if (run && !(run.status === "done" && run.outcome.status === "interrupted")) {
          const record = log
            .records()
            .filter((r) => r.kind === "run_accepted" && (r.data as AcceptedData).idempotencyKey === idempotencyKey)
            .at(-1);
          return {
            ok: true,
            run,
            joined: (record?.data as AcceptedData | undefined)?.joined === true,
            duplicate: true,
          };
        }
      }
      const running = held.running;
      if (running || held.compaction || held.queue.length > 0) {
        if (whenBusy === "reject") {
          return failure("busy", "the session is running another run", {
            reason: "running",
            ...(running ? { runId: running.runId } : {}),
          });
        }
        if (whenBusy === "steer" && running && !running.stoppedBy && !running.closing) {
          if (!capabilities.steer) return failure("unsupported", "this agent cannot steer a running run");
          log.append("run_accepted", {
            runId: running.runId,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
            source,
            joined: true,
          } satisfies AcceptedData);
          if (idempotencyKey !== undefined) held.keys.set(idempotencyKey, running.runId);
          running.messages.push(message);
          steerInto(running, message);
          return { ok: true, run: statusOf(held, log, running.runId) as RunStatus, joined: true, duplicate: false };
        }
        if (held.queue.length >= limits.queuedPerSession) {
          return failure("busy", `the session already has ${held.queue.length} queued runs`, { reason: "queue_full" });
        }
      }
      if (inFlight >= limits.inFlightPerProcess) {
        return failure("busy", `this process already has ${inFlight} runs in flight`, { reason: "capacity" });
      }
      const runId = crypto.randomUUID();
      log.append("run_accepted", {
        runId,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        source,
      } satisfies AcceptedData);
      if (idempotencyKey !== undefined) held.keys.set(idempotencyKey, runId);
      const hold = Scope.makeUnsafe();
      yield* Scope.provide(RcMap.get(sessions, held.sessionId), hold);
      inFlight++;
      held.queue.push({ runId, message, ...(idempotencyKey === undefined ? {} : { idempotencyKey }), source, hold });
      pump(held);
      emitState(held);
      return { ok: true, run: statusOf(held, log, runId) as RunStatus, joined: false, duplicate: false };
    });

  const notFound = (sessionId: string) => failure("not_found", `no session ${sessionId}`);

  const read = (held: Held, log: LoopLog, page: Page): PortRead => {
    const { entries } = published(log.records());
    const state = stateOf(held, log);
    let start: number;
    let end: number;
    if ("after" in page) {
      const index = page.after === null ? -1 : entries.findIndex((entry) => entry.id === page.after);
      if (page.after !== null && index < 0) return failure("not_found", `no entry ${page.after}`);
      start = index + 1;
      end = Math.min(entries.length, start + page.limit);
    } else {
      const index = page.before === null ? entries.length : entries.findIndex((entry) => entry.id === page.before);
      if (page.before !== null && index < 0) return failure("not_found", `no entry ${page.before}`);
      end = index;
      start = Math.max(0, end - page.limit);
    }
    return {
      ok: true,
      state,
      entries: entries.slice(start, end),
      more: { before: start > 0, after: end < entries.length },
    };
  };

  return {
    capabilities,

    submit: (sessionId, message, options) =>
      use(sessionId, (held) =>
        locked(
          held,
          Effect.gen(function* () {
            if (!held.log) held.log = yield* port(() => harness.create(sessionId, onRecord(held)));
            return yield* accept(held, held.log, message, options);
          }),
        ),
      ),

    getRun: (sessionId, key: RunKey) =>
      use(sessionId, (held) =>
        Effect.sync(() => {
          const log = held.log;
          if (!log) return undefined;
          const runId = "runId" in key ? key.runId : held.keys.get(key.idempotencyKey);
          return runId === undefined ? undefined : statusOf(held, log, runId);
        }),
      ),

    runEntries: (sessionId, runId, after) =>
      use(sessionId, (held) =>
        Effect.sync(() => {
          const log = held.log;
          if (!log) return notFound(sessionId);
          const { entries } = published(log.records());
          const index = after === undefined ? -1 : entries.findIndex((entry) => entry.id === after);
          if (after !== undefined && index < 0) return failure("not_found", `no entry ${after}`);
          return { ok: true as const, entries: entries.filter((entry, i) => i > index && entry.runId === runId) };
        }),
      ),

    cancelRun: (sessionId, runId) =>
      use(sessionId, (held) =>
        locked(
          held,
          Effect.sync((): Result => {
            const log = held.log;
            if (!log) return notFound(sessionId);
            const queued = held.queue.find((q) => q.runId === runId);
            if (queued) {
              withdraw(held, log, queued, "cancel");
              emitState(held);
              return { ok: true };
            }
            if (held.running?.runId === runId) {
              stop(held.running, "cancel");
              return { ok: true };
            }
            const run = statusOf(held, log, runId);
            return run ? failure("conflict", `run ${runId} has ended`) : failure("not_found", `no run ${runId}`);
          }),
        ),
      ),

    abort: (sessionId) =>
      use(sessionId, (held) =>
        locked(
          held,
          Effect.sync((): AbortResult => {
            const log = held.log;
            if (!log) return notFound(sessionId);
            const queued = held.queue.map((q) => q.runId);
            for (const q of [...held.queue]) withdraw(held, log, q, "abort");
            const running = held.running;
            if (running) stop(running, "abort");
            const compaction = held.compaction !== undefined;
            held.compaction?.controller.abort();
            emitState(held);
            return { ok: true, stopped: { ...(running ? { runId: running.runId } : {}), queued, compaction } };
          }),
        ),
      ),

    read: (sessionId, page) =>
      use(sessionId, (held) => Effect.sync(() => (held.log ? read(held, held.log, page) : notFound(sessionId)))),

    watch: (sessionId, listener) => {
      const set = listeners.get(sessionId) ?? new Set();
      listeners.set(sessionId, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(sessionId) === set) listeners.delete(sessionId);
      };
    },

    attachment: (sessionId, ref) =>
      use(sessionId, (held) => {
        const log = held.log;
        return log ? port(() => log.attachment(ref)) : Effect.succeed(undefined);
      }),

    create: (sessionId, fork) =>
      use(sessionId, (held) =>
        locked(
          held,
          Effect.gen(function* () {
            if (held.log) return failure("conflict", `session ${sessionId} exists`);
            if (!fork) {
              held.log = yield* port(() => harness.create(sessionId, onRecord(held)));
              return { ok: true } as Result;
            }
            if (!capabilities.fork) return failure("unsupported", "this agent cannot fork a session");
            const source = yield* RcMap.get(sessions, fork.sessionId);
            const from = source.log;
            if (!from) return notFound(fork.sessionId);
            const { entryId } = fork;
            if (entryId !== undefined && !published(from.records()).entries.some((entry) => entry.id === entryId)) {
              return failure("not_found", `no entry ${entryId} in session ${fork.sessionId}`);
            }
            held.log = yield* port(() =>
              harness.create(sessionId, onRecord(held), { from, ...(entryId === undefined ? {} : { entryId }) }),
            );
            return { ok: true } as Result;
          }),
        ),
      ),

    rewind: (sessionId, entryId) =>
      use(sessionId, (held) =>
        locked(
          held,
          Effect.gen(function* () {
            if (!capabilities.rewind) return failure("unsupported", "this agent cannot rewind a session");
            const log = held.log;
            if (!log) return notFound(sessionId);
            if (held.running || held.compaction)
              return failure("busy", "the session is running", { reason: "running" });
            if (!published(log.records()).entries.some((entry) => entry.id === entryId)) {
              return failure("not_found", `no entry ${entryId}`);
            }
            const result = yield* port(() => log.rewind(entryId));
            emitState(held);
            return result;
          }),
        ),
      ),

    compact: (sessionId, options = {}) =>
      use(sessionId, (held) =>
        Effect.gen(function* () {
          if (!capabilities.compaction) return failure("unsupported", "this agent cannot compact a session");
          const started = yield* locked(
            held,
            Effect.sync(() => {
              const log = held.log;
              if (!log) return notFound(sessionId);
              if (held.running || held.compaction) {
                return failure("busy", "the session is running", { reason: "running" });
              }
              const compaction = { controller: new AbortController(), done: Deferred.makeUnsafe<void>() };
              held.compaction = compaction;
              emitState(held);
              return { ok: true as const, log, compaction };
            }),
          );
          if (!started.ok) return started;
          const { log, compaction } = started;
          return yield* port(() => log.compact(options, compaction.controller.signal)).pipe(
            // Not under the lock: `delete` waits for `done` while holding it.
            Effect.ensuring(
              Effect.gen(function* () {
                held.compaction = undefined;
                yield* Deferred.succeed(compaction.done, undefined);
                pump(held);
                emitState(held);
              }),
            ),
          );
        }),
      ),

    update: (sessionId, settings) =>
      use(sessionId, (held) =>
        locked(
          held,
          Effect.gen(function* () {
            const unsupported = Object.keys(settings).filter(
              (field) => !capabilities.updatable.includes(field as never),
            );
            if (unsupported.length > 0) {
              return failure("unsupported", `this agent cannot update ${unsupported.join(", ")}`);
            }
            const log = held.log;
            if (!log) return notFound(sessionId);
            const result = yield* port(() => log.update(settings));
            emitState(held);
            return result;
          }),
        ),
      ),

    delete: (sessionId) =>
      use(sessionId, (held) =>
        locked(
          held,
          Effect.gen(function* () {
            if (!capabilities.delete) return failure("unsupported", "this agent cannot delete a session");
            const log = held.log;
            if (!log) return notFound(sessionId);
            for (const queued of [...held.queue]) withdraw(held, log, queued, "delete");
            const running = held.running;
            if (running) {
              stop(running, "delete");
              yield* Deferred.await(running.ended);
            }
            const compaction = held.compaction;
            if (compaction) {
              compaction.controller.abort();
              yield* Deferred.await(compaction.done);
            }
            log.close();
            held.log = undefined;
            held.span = undefined;
            held.keys.clear();
            yield* port(() => harness.delete(sessionId));
            return { ok: true } as Result;
          }),
        ),
      ),

    list: async () => {
      const summaries = await harness.list();
      return summaries.map((summary) =>
        active.get(summary.sessionId)?.running ? { ...summary, status: "running" as const } : summary,
      );
    },
    models: () => harness.models(),
    commands: () => harness.commands(),
  };
}
