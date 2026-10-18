/**
 * `LoopPort`: the harness port for a harness that is only a loop (docs/design/agent-service.md §9.1, §9.3). It owns
 * what such a harness lacks: admission, the queue, idempotency, message records and closing interrupted messages.
 *
 * Message records are plane markers in the session's own log, written through its one writer and never published:
 * `message_accepted`, `message_taken` (the entry a message became, as soon as the loop says) and `message_ended`. A
 * session's log is held from the first operation that acquires it until the session is idle and nothing holds it;
 * every operation acquires it, so a session has one writer, and the first acquisition in a process ends the messages a
 * previous process left open.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { PortFailure, port, portCleanup, portError } from "./effect-port.ts";
import type { Admission, HarnessPort, Page, PortRead } from "./harness-port.ts";
import { log as logger } from "./log.ts";
import {
  type AbortResult,
  type AgentCommand,
  type Attachment,
  type Capabilities,
  type DoneMessage,
  type Entry,
  type Json,
  LIMITS,
  type LiveEvent,
  type MessageKey,
  type MessageSource,
  type MessageStatus,
  type ModelDescriptor,
  type Outcome,
  type Prompt,
  type Result,
  type SessionEvent,
  type SessionSettings,
  type SessionState,
  type SessionSummary,
  type Usage,
  type WhenBusy,
  agentError,
  failure,
} from "./protocol.ts";

/** One record of a session's log: the harness's entries and `LoopPort`'s message records alike. */
export interface LogRecord {
  id: string;
  parentEntryId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}

export type MessageMarker = "message_accepted" | "message_taken" | "message_ended";

const MARKERS: ReadonlySet<string> = new Set<MessageMarker>(["message_accepted", "message_taken", "message_ended"]);

/** How a loop's work ended: `canceled` and `interrupted` are the port's to say. */
export type LoopOutcome = Extract<Outcome, { status: "completed" | "max_tokens" | "intercepted" | "failed" }>;

/** A message handed to a loop, under the id its fate is reported by. */
export interface HandedMessage {
  readonly id: string;
  readonly prompt: Prompt;
}

/**
 * What became of a handed message: written as the `user_message` entry `taken`, or consumed by something in the harness
 * that writes no entry (an extension command or input handler).
 */
export type MessageFate = { taken: string } | { handled: true };

export interface LoopHooks {
  emit(event: LiveEvent): void;
  /**
   * Said once per message, as it happens. Only the loop can tell (an extension may consume a message; pi's `steer()`
   * can queue after its work settled), so a message it has said nothing for when its work ends counts as not taken, and
   * the next work takes it. `taken` is said before the entry it names reaches `onRecord`, so that entry is published
   * naming its message; it must not write the log itself.
   */
  fate(messageId: string, fate: MessageFate): void;
}

export interface LoopRun {
  /** Hand a message to the work, which takes it after its current tool round. */
  steer(message: HandedMessage): void;
  stop(): void;
  readonly done: Promise<{ outcome: LoopOutcome; usage?: Usage }>;
}

/** A session's log, opened for writing. `LoopPort` holds at most one per session at a time. */
export interface LoopLog {
  /** Every record, in append order. */
  records(): readonly LogRecord[];
  /** Durable when it returns; reported to `onRecord` like every other append. */
  append(kind: MessageMarker, data: Json): LogRecord;
  state(): Omit<SessionState, "status" | "taken" | "queued">;
  /** Start work on this log. The harness writes the message as a `user_message` entry when it takes it. */
  run(message: HandedMessage, hooks: LoopHooks): LoopRun;
  rewind(entryId: string): Promise<Result>;
  compact(options: { instructions?: string }, signal: AbortSignal): Promise<Result>;
  update(settings: SessionSettings): Promise<Result>;
  attachment(ref: string): Promise<Attachment | undefined>;
  close(): void;
}

/**
 * Every call either answers or rejects; a rejection with an `AgentRejection` of code `unavailable` says the storage
 * cannot answer now, and reaches the caller as that. Any other rejection is a harness failure, reported `internal`.
 */
export interface LoopHarness {
  readonly capabilities: Omit<Capabilities, "durableQueue" | "durableWork">;
  /** `onRecord` sees every record appended from now on, by the harness or by `LoopPort`, once it is durable. */
  open(sessionId: string, onRecord: (record: LogRecord) => void): Promise<LoopLog | undefined>;
  /**
   * A fork copies the source's conversation up to `entryId`, never its message records: messages are not copied.
   * `recent` bounds what the model is given of that copy, for a harness that manages context; one that does not copies
   * it whole.
   */
  create(
    sessionId: string,
    onRecord: (record: LogRecord) => void,
    fork?: { from: LoopLog; entryId?: string; context?: "full" | "recent" },
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

type AcceptedData = { messageId: string; idempotencyKey?: string; source: MessageSource };
type TakenData = { messageId: string; entryId: string };
/**
 * `entryId` repeats `message_taken`'s, so an end is whole even when that record was refused; `answer` is the entry id
 * of the work's final `assistant_message`.
 */
type EndedData = {
  messageId: string;
  outcome: Outcome;
  entryId?: string;
  lastEntryId?: string;
  usage?: Usage;
  answer?: string;
};

type StopReason = "cancel" | "abort" | "delete";

/** An accepted message that has not ended. */
interface Pending {
  readonly messageId: string;
  readonly prompt: Prompt;
  readonly idempotencyKey?: string;
  readonly source: MessageSource;
  /** Holds the session until the message ends. */
  readonly hold: Scope.Closeable;
}

/** One piece of work: what the loop does from taking its first message to settling. */
interface Work {
  readonly ended: Deferred.Deferred<void>;
  loop: LoopRun;
  stoppedBy?: StopReason;
  /** Set once the loop settled: a steer arriving after it waits for the next work. */
  closing: boolean;
  /** Its first message, then each one steered in, in the order they were accepted. */
  readonly messages: Pending[];
  /** What each message became: its entry, or `null` when consumed without one. */
  readonly fates: Map<string, string | null>;
  /** The newest `assistant_message` it wrote: its answer when it ends. */
  answer?: string;
}

interface Held {
  readonly sessionId: string;
  readonly lock: Semaphore.Semaphore;
  log: LoopLog | undefined;
  /** The log read so far, for the live path; reads project the whole log again. */
  projection: Projection;
  /** Which message each `user_message` entry is. */
  readonly named: Map<string, string>;
  /** `message_taken` records owed: written right after the entry each names is reported. */
  readonly owed: TakenData[];
  readonly keys: Map<string, string>;
  /** Steered messages the last work did not take: the next work takes them, before the queue. */
  readonly carried: Pending[];
  readonly queue: Pending[];
  work: Work | undefined;
  compaction: { readonly controller: AbortController; readonly done: Deferred.Deferred<void> } | undefined;
}

const markerOf = (record: LogRecord): string | undefined =>
  MARKERS.has(record.kind) ? (record.data as { messageId: string }).messageId : undefined;

/** What reading the log so far has established: each record's nearest published ancestor, and the newest entry. */
interface Projection {
  readonly visible: Map<string, string | undefined>;
  last: string | undefined;
}

const emptyProjection = (): Projection => ({ visible: new Map(), last: undefined });

/**
 * A record as published, or `undefined` for a message record. A published entry's parent is its nearest published
 * ancestor, so an entry never names one a caller cannot read; a `user_message` names the message it is.
 */
function project(projection: Projection, named: ReadonlyMap<string, string>, record: LogRecord): Entry | undefined {
  const parent = record.parentEntryId === undefined ? undefined : projection.visible.get(record.parentEntryId);
  if (MARKERS.has(record.kind)) {
    projection.visible.set(record.id, parent);
    return undefined;
  }
  projection.visible.set(record.id, record.id);
  projection.last = record.id;
  const { parentEntryId: _stored, ...rest } = record;
  const messageId = record.kind === "user_message" ? named.get(record.id) : undefined;
  return {
    ...rest,
    ...(parent === undefined ? {} : { parentEntryId: parent }),
    ...(messageId === undefined ? {} : { data: { ...(record.data as Record<string, Json>), messageId } }),
  };
}

function namedIn(records: readonly LogRecord[]): Map<string, string> {
  const named = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== "message_taken") continue;
    const { messageId, entryId } = record.data as TakenData;
    named.set(entryId, messageId);
  }
  return named;
}

function published(records: readonly LogRecord[]): { entries: Entry[]; projection: Projection } {
  const named = namedIn(records);
  const projection = emptyProjection();
  const entries: Entry[] = [];
  for (const record of records) {
    const entry = project(projection, named, record);
    if (entry) entries.push(entry);
  }
  return { entries, projection };
}

/** A harness that throws instead of starting work gets work that failed, so its messages still end once. */
function failedRun(error: unknown): LoopRun {
  const message = error instanceof Error ? error.message : String(error);
  return {
    steer: () => {},
    stop: () => {},
    done: Promise.resolve({ outcome: { status: "failed", error: agentError("internal", message) } }),
  };
}

const NOT_STARTED = failedRun("the work has not started");

const PREVIEW_CHARS = 80;

export interface LoopPortHooks {
  /** Marks work in flight (a message not yet done, a compaction) for whoever asks if the process is idle. */
  beginWork?: () => () => void;
}

export function loopPort(
  harness: LoopHarness,
  limits: LoopPortLimits = {
    queuedPerSession: LIMITS.queuedPerSession,
    inFlightPerProcess: LIMITS.inFlightPerProcess,
  },
  hooks: LoopPortHooks = {},
): HarnessPort {
  const capabilities: Capabilities = { ...harness.capabilities, durableQueue: false, durableWork: false };
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

  /** The messages not taken yet, in the order they will be taken: the work's own untaken ones, then the queue. */
  const waiting = (held: Held): Pending[] => [
    ...(held.work ? held.work.messages.filter((m) => !held.work?.fates.has(m.messageId)) : []),
    ...held.carried,
    ...held.queue,
  ];

  const takenIn = (held: Held): { pending: Pending; entryId: string }[] => {
    const work = held.work;
    if (!work) return [];
    return work.messages.flatMap((pending) => {
      const entryId = work.fates.get(pending.messageId);
      return typeof entryId === "string" ? [{ pending, entryId }] : [];
    });
  };

  const stateOf = (held: Held, log: LoopLog): SessionState => {
    const records = log.records();
    const timestampOf = (id: string) => records.find((r) => r.id === id)?.timestamp ?? Date.now();
    const { leafEntryId: leaf, ...state } = log.state();
    // The harness's leaf can be a message record, which is never published: the head a caller sees is the entry
    // nearest above it.
    const leafEntryId = leaf === undefined ? undefined : published(records).projection.visible.get(leaf);
    return {
      ...state,
      ...(leafEntryId === undefined ? {} : { leafEntryId }),
      status: held.work ? "running" : held.compaction ? "compacting" : "idle",
      taken: takenIn(held).map(({ pending, entryId }) => ({
        messageId: pending.messageId,
        takenAt: timestampOf(entryId),
      })),
      queued: waiting(held).map((pending) => ({
        messageId: pending.messageId,
        ...(pending.idempotencyKey === undefined ? {} : { idempotencyKey: pending.idempotencyKey }),
        preview: pending.prompt.text.slice(0, PREVIEW_CHARS),
      })),
    };
  };

  const emitState = (held: Held): void => {
    if (held.log && listeners.has(held.sessionId)) {
      emit(held.sessionId, { type: "state", state: stateOf(held, held.log) });
    }
  };

  /**
   * A record the storage refused. Callers take the message out of memory first, so it reads as `interrupted` (accepted,
   * not ended, neither taken nor queued), and the session goes on with the rest of its work. The `serving_error` is
   * what ends a stream waiting for this message's `done`.
   */
  const recorded = (held: Held, log: LoopLog, kind: MessageMarker, data: Json, messageId: string): boolean => {
    try {
      log.append(kind, data);
      return true;
    } catch (error) {
      const message = `could not record ${kind} of message ${messageId}; it reads as interrupted: ${String(error)}`;
      logger.error(`[fastagent] ${message}`);
      emit(held.sessionId, { type: "serving_error", message });
      return false;
    }
  };

  const payOwed = (held: Held, log: LoopLog): void => {
    for (let taken = held.owed.shift(); taken; taken = held.owed.shift()) {
      recorded(held, log, "message_taken", taken, taken.messageId);
    }
  };

  const onRecord =
    (held: Held) =>
    (record: LogRecord): void => {
      const entry = project(held.projection, held.named, record);
      if (record.kind === "assistant_message" && held.work) held.work.answer = record.id;
      if (entry) emit(held.sessionId, { type: "entry", entry });
      if (held.log && held.owed.length > 0) payOwed(held, held.log);
    };

  /** End the messages a previous process left open, and index the keys. Runs before anything else on the session. */
  const reconcile = (held: Held, log: LoopLog): void => {
    const records = log.records();
    const { projection } = published(records);
    held.projection = projection;
    for (const [entryId, messageId] of namedIn(records)) held.named.set(entryId, messageId);
    const taken = new Map<string, string>();
    const ended = new Set<string>();
    const open: string[] = [];
    for (const record of records) {
      if (record.kind === "message_taken") {
        const data = record.data as TakenData;
        taken.set(data.messageId, data.entryId);
      }
      if (record.kind === "message_ended") ended.add((record.data as EndedData).messageId);
      if (record.kind !== "message_accepted") continue;
      const data = record.data as AcceptedData;
      if (data.idempotencyKey !== undefined) held.keys.set(data.idempotencyKey, data.messageId);
      open.push(data.messageId);
    }
    // Nothing has been appended since the work stopped, so the newest entry is where it ended.
    const tail = projection.last;
    for (const messageId of open) {
      if (ended.has(messageId)) continue;
      const entryId = taken.get(messageId);
      const data: EndedData = {
        messageId,
        outcome: { status: "interrupted" },
        ...(entryId === undefined ? {} : { entryId, ...(tail === undefined ? {} : { lastEntryId: tail }) }),
      };
      log.append("message_ended", data);
    }
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
                projection: emptyProjection(),
                named: new Map(),
                owed: [],
                keys: new Map(),
                carried: [],
                queue: [],
                work: undefined,
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

  /** Rejects with the harness's own error, so an `AgentRejection` it threw (its storage is unavailable) arrives as is. */
  const use = async <A, E>(sessionId: string, work: (held: Held) => Effect.Effect<A, E, Scope.Scope>): Promise<A> => {
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.flatMap(RcMap.get(sessions, sessionId), work)));
    if (Exit.isSuccess(exit)) return exit.value;
    throw portError(exit.cause);
  };

  const locked = <A, E, R>(held: Held, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Semaphore.withPermits(held.lock, 1)(work);

  /** A message's status, for every read alike: the log says accepted, taken and done; memory says queued or taken. */
  const statusOf = (held: Held, log: LoopLog, messageId: string): MessageStatus | undefined => {
    const records = log.records();
    let accepted: AcceptedData | undefined;
    let takenAt: number | undefined;
    let entryId: string | undefined;
    let ended: { data: EndedData; at: number } | undefined;
    for (const record of records) {
      if (markerOf(record) !== messageId) continue;
      if (record.kind === "message_accepted") accepted = record.data as AcceptedData;
      if (record.kind === "message_taken") entryId = (record.data as TakenData).entryId;
      if (record.kind === "message_ended") ended = { data: record.data as EndedData, at: record.timestamp };
    }
    if (!accepted) return undefined;
    const fate = held.work?.fates.get(messageId);
    entryId ??= ended?.data.entryId ?? (typeof fate === "string" ? fate : undefined);
    if (entryId !== undefined) takenAt = records.find((r) => r.id === entryId)?.timestamp;
    const base = {
      messageId,
      ...(accepted.idempotencyKey === undefined ? {} : { idempotencyKey: accepted.idempotencyKey }),
      source: accepted.source,
    };
    const taken = entryId === undefined ? {} : { entryId, ...(takenAt === undefined ? {} : { takenAt }) };
    if (ended) {
      const { outcome, lastEntryId, usage, answer } = ended.data;
      const answerRecord = answer === undefined ? undefined : records.find((r) => r.id === answer);
      return {
        ...base,
        status: "done",
        ...taken,
        ...(lastEntryId === undefined ? {} : { lastEntryId }),
        endedAt: ended.at,
        outcome,
        ...(usage ? { usage } : {}),
        ...(answerRecord
          ? { answer: { entryId: answerRecord.id, text: String((answerRecord.data as { text?: unknown }).text ?? "") } }
          : {}),
      };
    }
    if (entryId !== undefined && held.work?.messages.some((m) => m.messageId === messageId)) {
      return { ...base, status: "taken", entryId, takenAt: takenAt ?? Date.now() };
    }
    const position = waiting(held).findIndex((pending) => pending.messageId === messageId);
    if (position >= 0) return { ...base, status: "queued", position };
    // Accepted, not ended, and not in memory: one this process never ended. `reconcile` ends them on acquisition.
    return { ...base, status: "done", ...taken, endedAt: Date.now(), outcome: { status: "interrupted" } };
  };

  const release = (hold: Scope.Closeable): void => {
    Effect.runFork(Scope.close(hold, Exit.void));
  };

  /**
   * Record a message's end, report it, and only then let go of what held it: the last hold on a session closes its log.
   * The caller has taken it out of memory.
   */
  const end = (held: Held, log: LoopLog, pending: Pending, ending: Omit<EndedData, "messageId">): void => {
    if (recorded(held, log, "message_ended", { messageId: pending.messageId, ...ending }, pending.messageId)) {
      const status = statusOf(held, log, pending.messageId);
      if (status?.status === "done") emit(held.sessionId, { type: "done", message: status as DoneMessage });
    }
    inFlight--;
    release(pending.hold);
  };

  const withdraw = (held: Held, log: LoopLog, pending: Pending, by: StopReason): void => {
    for (const list of [held.queue, held.carried]) {
      const index = list.indexOf(pending);
      if (index >= 0) list.splice(index, 1);
    }
    end(held, log, pending, { outcome: { status: "canceled", by } });
  };

  /** `abort` and `delete` override an earlier `cancel`: they also withdraw the steers the work has not taken. */
  const stop = (work: Work, by: StopReason): void => {
    const first = work.stoppedBy === undefined;
    if (first || by !== "cancel") work.stoppedBy = by;
    if (first) work.loop.stop();
  };

  /** A loop that throws instead of taking the message says nothing for it, so it counts as untaken. */
  const steerInto = (work: Work, pending: Pending): void => {
    try {
      work.loop.steer({ id: pending.messageId, prompt: pending.prompt });
    } catch (error) {
      logger.error(`[fastagent] steering threw; the next work takes message ${pending.messageId}: ${String(error)}`);
    }
  };

  const startLoop = (held: Held, log: LoopLog, work: Work, first: Pending): LoopRun => {
    try {
      return log.run(
        { id: first.messageId, prompt: first.prompt },
        {
          emit: (event) => emit(held.sessionId, event),
          fate: (messageId, fate) => {
            if (work.fates.has(messageId)) return;
            const pending = work.messages.find((m) => m.messageId === messageId);
            if (!pending) return;
            if ("taken" in fate) {
              work.fates.set(messageId, fate.taken);
              held.named.set(fate.taken, messageId);
              held.owed.push({ messageId, entryId: fate.taken });
              return;
            }
            // Consumed by a command or an input handler: no model will be called for it.
            work.fates.set(messageId, null);
            end(held, log, pending, { outcome: { status: "intercepted" } });
            emitState(held);
          },
        },
      );
    } catch (error) {
      logger.error(`[fastagent] the harness could not start work on message ${first.messageId}: ${String(error)}`);
      return failedRun(error);
    }
  };

  /** How each of a work's messages ends, and which steered ones the next work takes. */
  const settle = (held: Held, log: LoopLog, work: Work, outcome: Outcome, usage: Usage | undefined): void => {
    payOwed(held, log);
    const stoppedBy = work.stoppedBy;
    const final: Outcome = stoppedBy ? { status: "canceled", by: stoppedBy } : outcome;
    const lastEntryId = held.projection.last;
    const [first] = work.messages;
    // Usage is reported once, on the first message the work took (SPEC v1 §4).
    const usageOwner = work.messages.find((m) => typeof work.fates.get(m.messageId) === "string") ?? (first as Pending);
    const carried: Pending[] = [];
    for (const pending of work.messages) {
      const fate = work.fates.get(pending.messageId);
      if (fate === null) continue;
      const untakenSteer = fate === undefined && pending !== first;
      if (untakenSteer && stoppedBy !== "abort" && stoppedBy !== "delete") {
        carried.push(pending);
        continue;
      }
      end(held, log, pending, {
        outcome: untakenSteer ? { status: "canceled", by: stoppedBy as StopReason } : final,
        ...(fate === undefined ? {} : { entryId: fate }),
        ...(fate === undefined || lastEntryId === undefined ? {} : { lastEntryId }),
        ...(pending === usageOwner && usage ? { usage } : {}),
        ...(fate === undefined || work.answer === undefined ? {} : { answer: work.answer }),
      });
    }
    held.carried.unshift(...carried);
  };

  const drive = (held: Held, log: LoopLog, work: Work): Effect.Effect<void> =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(port(() => work.loop.done));
      work.closing = true;
      if (Exit.isSuccess(result)) return result.value;
      logger.error(`[fastagent] work rejected instead of ending: ${String(result.cause)}`);
      return { outcome: { status: "failed", error: agentError("internal", "the harness failed the work") } } as {
        outcome: Outcome;
        usage?: Usage;
      };
    }).pipe(
      Effect.flatMap(({ outcome, usage }) =>
        Effect.sync(() => {
          held.work = undefined;
          settle(held, log, work, outcome, usage);
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => logger.error(`[fastagent] ending work failed in LoopPort: ${String(cause)}`)),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          held.work = undefined;
          yield* Deferred.succeed(work.ended, undefined);
          pump(held);
          emitState(held);
        }),
      ),
    );

  const pump = (held: Held): void => {
    const log = held.log;
    if (!log || held.work || held.compaction) return;
    const steered = held.carried.length > 0;
    const first = steered ? held.carried.shift() : held.queue.shift();
    if (!first) return;
    const work: Work = {
      ended: Deferred.makeUnsafe<void>(),
      loop: NOT_STARTED,
      closing: false,
      messages: [first],
      fates: new Map(),
    };
    held.work = work;
    work.loop = startLoop(held, log, work, first);
    // The next work takes every steered message the last one left, not only the first.
    if (steered) {
      for (const pending of held.carried.splice(0)) {
        work.messages.push(pending);
        steerInto(work, pending);
      }
    }
    Effect.runFork(drive(held, log, work));
  };

  /**
   * A session that does not exist yet is created only once nothing can refuse the message, and removed again if its
   * first record is refused: a rejected invoke records nothing (SPEC v1 §3.1).
   */
  const recordAccepted = (held: Held, data: AcceptedData): Effect.Effect<LoopLog, PortFailure> =>
    Effect.gen(function* () {
      const existing = held.log;
      const log = existing ?? (yield* port(() => harness.create(held.sessionId, onRecord(held))));
      held.log = log;
      yield* Effect.try({
        try: () => log.append("message_accepted", data),
        catch: (cause) => new PortFailure(cause),
      }).pipe(
        Effect.onError(() =>
          existing
            ? Effect.void
            : Effect.suspend(() => {
                log.close();
                held.log = undefined;
                return portCleanup(`removing session ${held.sessionId}`, () => harness.delete(held.sessionId));
              }),
        ),
      );
      return log;
    });

  const accept = (
    held: Held,
    prompt: Prompt,
    options: { whenBusy: WhenBusy; idempotencyKey?: string; source: MessageSource },
  ): Effect.Effect<Admission, PortFailure, Scope.Scope> =>
    Effect.gen(function* () {
      const { whenBusy, idempotencyKey, source } = options;
      const existing = held.log;
      if (existing && idempotencyKey !== undefined) {
        const known = held.keys.get(idempotencyKey);
        const message = known === undefined ? undefined : statusOf(held, existing, known);
        if (message && !(message.status === "done" && message.outcome.status === "interrupted")) {
          return { ok: true, message, duplicate: true };
        }
      }
      const work = held.work;
      const busy = work !== undefined || held.compaction !== undefined || waiting(held).length > 0;
      const steer = busy && whenBusy === "steer";
      if (busy) {
        if (whenBusy === "reject") return failure("busy", "the session is working", { reason: "running" });
        if (steer && !capabilities.steer) return failure("unsupported", "this agent cannot steer");
        const queued = waiting(held).length;
        if (queued >= limits.queuedPerSession) {
          return failure("busy", `the session already has ${queued} queued messages`, { reason: "queue_full" });
        }
      }
      if (inFlight >= limits.inFlightPerProcess) {
        return failure("busy", `this process already has ${inFlight} messages in flight`, { reason: "capacity" });
      }
      const messageId = crypto.randomUUID();
      const log = yield* recordAccepted(held, {
        messageId,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        source,
      });
      if (idempotencyKey !== undefined) held.keys.set(idempotencyKey, messageId);
      const hold = Scope.makeUnsafe();
      yield* Scope.provide(RcMap.get(sessions, held.sessionId), hold);
      // The hold is closed once, however the message ends, so its work-in-flight mark ends with it.
      const workDone = hooks.beginWork?.();
      if (workDone) yield* Scope.addFinalizer(hold, Effect.sync(workDone));
      inFlight++;
      const pending: Pending = {
        messageId,
        prompt,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        source,
        hold,
      };
      if (steer && work && !work.stoppedBy && !work.closing) {
        work.messages.push(pending);
        steerInto(work, pending);
      } else if (steer) {
        held.carried.push(pending);
      } else {
        held.queue.push(pending);
      }
      pump(held);
      emitState(held);
      return { ok: true, message: statusOf(held, log, messageId) as MessageStatus, duplicate: false };
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

    submit: (sessionId, message, options) => use(sessionId, (held) => locked(held, accept(held, message, options))),

    getMessage: (sessionId, key: MessageKey) =>
      use(sessionId, (held) =>
        Effect.sync(() => {
          const log = held.log;
          if (!log) return undefined;
          const messageId = "messageId" in key ? key.messageId : held.keys.get(key.idempotencyKey);
          return messageId === undefined ? undefined : statusOf(held, log, messageId);
        }),
      ),

    messageEntries: (sessionId, messageId, after) =>
      use(sessionId, (held) =>
        Effect.sync(() => {
          const log = held.log;
          if (!log) return notFound(sessionId);
          const status = statusOf(held, log, messageId);
          if (!status) return failure("not_found", `no message ${messageId}`);
          const { entries } = published(log.records());
          const cursor = after === undefined ? -1 : entries.findIndex((entry) => entry.id === after);
          if (after !== undefined && cursor < 0) return failure("not_found", `no entry ${after}`);
          const ended = log.records().some((r) => r.kind === "message_ended" && markerOf(r) === messageId);
          if (status.status === "queued" || status.entryId === undefined) {
            return { ok: true as const, entries: [], ended };
          }
          const { entryId } = status;
          const first = Math.max(
            entries.findIndex((entry) => entry.id === entryId),
            cursor + 1,
          );
          const last =
            status.status === "done" && status.lastEntryId !== undefined
              ? entries.findIndex((entry) => entry.id === status.lastEntryId)
              : entries.length - 1;
          return { ok: true as const, entries: entries.slice(first, last + 1), ended };
        }),
      ),

    cancelMessage: (sessionId, messageId) =>
      use(sessionId, (held) =>
        locked(
          held,
          Effect.sync((): Result => {
            const log = held.log;
            if (!log) return notFound(sessionId);
            const queued = [...held.carried, ...held.queue].find((p) => p.messageId === messageId);
            if (queued) {
              withdraw(held, log, queued, "cancel");
              emitState(held);
              return { ok: true };
            }
            const work = held.work;
            const inWork = work?.messages.find((m) => m.messageId === messageId);
            if (work && inWork) {
              if (inWork === work.messages[0] || work.fates.has(messageId)) {
                stop(work, "cancel");
                return { ok: true };
              }
              // A steer the loop holds and has not taken. pi offers no way to take a handed message back, so should
              // the loop take it after all, its entry stays in the history without naming it.
              work.fates.set(messageId, null);
              end(held, log, inWork, { outcome: { status: "canceled", by: "cancel" } });
              emitState(held);
              return { ok: true };
            }
            const message = statusOf(held, log, messageId);
            return message
              ? failure("conflict", `message ${messageId} is done`)
              : failure("not_found", `no message ${messageId}`);
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
            const taken = takenIn(held).map(({ pending }) => pending.messageId);
            const queued = waiting(held).map((pending) => pending.messageId);
            for (const pending of [...held.carried, ...held.queue]) withdraw(held, log, pending, "abort");
            if (held.work) stop(held.work, "abort");
            const compaction = held.compaction !== undefined;
            held.compaction?.controller.abort();
            emitState(held);
            return { ok: true, stopped: { taken, queued, compaction } };
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
            const { entryId, context } = fork;
            if (entryId !== undefined && !published(from.records()).entries.some((entry) => entry.id === entryId)) {
              return failure("not_found", `no entry ${entryId} in session ${fork.sessionId}`);
            }
            held.log = yield* port(() =>
              harness.create(sessionId, onRecord(held), {
                from,
                ...(entryId === undefined ? {} : { entryId }),
                ...(context === undefined ? {} : { context }),
              }),
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
            if (held.work || held.compaction) return failure("busy", "the session is working", { reason: "running" });
            if (!published(log.records()).entries.some((entry) => entry.id === entryId)) {
              return failure("not_found", `no entry ${entryId}`);
            }
            // The head a caller sees already: the harness's own leaf may be a message record below it, which changes
            // nothing the next work continues from.
            if (stateOf(held, log).leafEntryId === entryId) return { ok: true } as Result;
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
              if (held.work || held.compaction) {
                return failure("busy", "the session is working", { reason: "running" });
              }
              const compaction = { controller: new AbortController(), done: Deferred.makeUnsafe<void>() };
              held.compaction = compaction;
              emitState(held);
              return { ok: true as const, log, compaction };
            }),
          );
          if (!started.ok) return started;
          const { log, compaction } = started;
          const workDone = hooks.beginWork?.();
          return yield* port(() => log.compact(options, compaction.controller.signal)).pipe(
            // Not under the lock: `delete` waits for `done` while holding it.
            Effect.ensuring(
              Effect.gen(function* () {
                workDone?.();
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
            for (const pending of [...held.carried, ...held.queue]) withdraw(held, log, pending, "delete");
            const work = held.work;
            if (work) {
              stop(work, "delete");
              yield* Deferred.await(work.ended);
            }
            const compaction = held.compaction;
            if (compaction) {
              compaction.controller.abort();
              yield* Deferred.await(compaction.done);
            }
            log.close();
            held.log = undefined;
            held.projection = emptyProjection();
            held.named.clear();
            held.keys.clear();
            yield* port(() => harness.delete(sessionId));
            return { ok: true } as Result;
          }),
        ),
      ),

    list: async () => {
      const summaries = await harness.list();
      return summaries.map((summary) =>
        active.get(summary.sessionId)?.work ? { ...summary, status: "running" as const } : summary,
      );
    },
    models: () => harness.models(),
    commands: () => harness.commands(),
  };
}
