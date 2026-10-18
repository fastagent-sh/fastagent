/**
 * The serving layer: the SPEC v1 `Agent` over any harness port, written once (docs/design/agent-service.md §9.1). It
 * owns what is the same for every harness: naming sessions, the request rules a type cannot carry, the invoke stream
 * (a receipt, then the message replayed from its own entry until its `done`), `follow`, and pages of `read`.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { port as fromPort, portError } from "./effect-port.ts";
import type { HarnessPort, Page, PortRead } from "./harness-port.ts";
import { log } from "./log.ts";
import {
  type Agent,
  type AgentError,
  AgentRejection,
  type Entry,
  type FollowEvent,
  type InvokeEvent,
  type InvokeRequest,
  LIMITS,
  type ReadResult,
  type Result,
  type Session,
  type SessionEvent,
  agentError,
  failure,
  isAddressable,
} from "./protocol.ts";

/** The rules a request's type cannot carry. Decoding untyped input into an `InvokeRequest` is the transport's. */
function invalid(request: InvokeRequest): AgentError | undefined {
  const { sessionId, idempotencyKey } = request;
  if (sessionId !== undefined && !isAddressable(sessionId)) {
    return agentError("invalid_request", `session id ${JSON.stringify(sessionId)} cannot be addressed`);
  }
  if (idempotencyKey !== undefined) {
    if (sessionId === undefined) return agentError("invalid_request", "an idempotencyKey requires a sessionId");
    if (idempotencyKey.length < 1 || idempotencyKey.length > LIMITS.idempotencyKeyMax) {
      return agentError("invalid_request", `an idempotencyKey has 1 to ${LIMITS.idempotencyKeyMax} characters`);
    }
  }
  return undefined;
}

/**
 * A port that rejected. Its own `AgentRejection` (its storage cannot answer now) is the caller's answer as it is;
 * anything else is a harness failure or a bug, reported `internal`.
 */
function portFailed(operation: string, cause: unknown): AgentError {
  if (cause instanceof AgentRejection) {
    log.warn(`[fastagent] ${operation}: ${cause.code}: ${cause.message}`);
    const { code, message, retryable, details } = cause;
    return { code, message, retryable, ...(details === undefined ? {} : { details }) };
  }
  log.error(`[fastagent] ${operation} failed in the harness: ${String(cause)}`);
  return agentError("internal", `${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
}

const settle =
  (operation: string) =>
  <T>(pending: Promise<T>): Promise<T | { ok: false; error: AgentError }> =>
    pending.catch((cause: unknown) => ({ ok: false as const, error: portFailed(operation, cause) }));

/** A read without a failure branch: the port's own `AgentRejection` (its storage is unavailable) passes as it is. */
const rejectRead =
  (operation: string) =>
  <T>(pending: Promise<T>): Promise<T> =>
    pending.catch((cause: unknown) => {
      if (cause instanceof AgentRejection) throw cause;
      throw new AgentRejection(portFailed(operation, cause), { cause });
    });

const unrecordedEnd = (messageId: string): AgentError =>
  agentError("internal", `message ${messageId} has no recorded end; it reads as interrupted`);

const failedStream = (error: AgentError): Stream.Stream<SessionEvent> =>
  Stream.succeed({ type: "serving_error", message: error.message });

/** A follow's page the port refused (the session went away mid-way) is an answer, not a harness failure. */
const followFailed = (cause: unknown): Stream.Stream<SessionEvent> =>
  cause instanceof AgentRejection
    ? Stream.succeed({ type: "serving_error", message: cause.message })
    : failedStream(portFailed("follow", cause));

const entryEvent = (entry: Entry): SessionEvent => ({ type: "entry", entry });

const isEntryOf = (messageId: string, entry: Entry): boolean =>
  entry.kind === "user_message" && (entry.data as { messageId?: unknown }).messageId === messageId;

/**
 * Which of the events `Delivered` lets through a message's stream carries: its own `done`, and errors; never a session
 * `state`. Entries and live events are the message's once `Delivered` has opened on its own entry.
 */
function forMessage(messageId: string): (event: SessionEvent) => boolean {
  return (event) => {
    if (event.type === "state") return false;
    if (event.type === "done") return event.message.messageId === messageId;
    return true;
  };
}

/** Events that are not a place in the log: they are delivered whenever they arrive. */
const unplaced = (event: SessionEvent): boolean =>
  event.type === "state" || event.type === "done" || event.type === "serving_error";

const utf8 = new TextEncoder();

/**
 * Where a subscriber stands in the log: the newest entry it was given, from a read or live, which is where its next
 * read starts. A subscription opens before its first read, so the live queue holds events from before that read's end
 * as well as after it. Each live event says which entry it followed (`after`), and only one that follows `last` is
 * new: an entry the read already gave, or a delta of a message whose entry it gave, is not, and neither is anything
 * older than the read. `opensOn`, when given, keeps a subscriber that has read nothing closed until that entry
 * arrives: a message's stream before the message is taken.
 */
interface Delivered {
  last: string | undefined;
  /** An entry given from a read of the log. */
  read(entry: Entry): void;
  /** Whether a live event is new to this subscriber, and placed after what it was given. */
  live(event: SessionEvent, after: string | undefined): boolean;
}

function deliveredFrom(cursor: string | undefined, opensOn?: (entry: Entry) => boolean): Delivered {
  let open = opensOn === undefined;
  const delivered: Delivered = {
    last: cursor,
    read(entry) {
      open = true;
      delivered.last = entry.id;
    },
    live(event, after) {
      if (unplaced(event)) return true;
      if (!open) {
        if (event.type !== "entry" || !opensOn?.(event.entry)) return false;
        open = true;
        delivered.last = event.entry.id;
        return true;
      }
      if (after !== delivered.last) return false;
      if (event.type === "entry") delivered.last = event.entry.id;
      return true;
    },
  };
  return delivered;
}

/** How far one subscriber may fall behind the live events, in events and in UTF-8 JSON bytes. */
export const LIVE_BACKLOG = { events: 10_000, bytes: 8 << 20 };

/** A page trimmed to the byte budget from the side away from its cursor, keeping at least one entry. */
function withinBudget(entries: Entry[], keepNewest: boolean): Entry[] {
  const ordered = keepNewest ? [...entries].reverse() : entries;
  const kept: Entry[] = [];
  let bytes = 0;
  for (const entry of ordered) {
    bytes += utf8.encode(JSON.stringify(entry)).byteLength;
    if (kept.length > 0 && bytes > LIMITS.pageBytes) break;
    kept.push(entry);
  }
  return keepNewest ? kept.reverse() : kept;
}

export function servingAgent(port: HarnessPort): Agent {
  type Watched = Effect.Success<ReturnType<typeof watched>>;
  /**
   * A session's live events for one subscriber, subscribed before anything is read so nothing appended in between is
   * missed. Bounded: a subscriber that falls further behind than {@link LIVE_BACKLOG} is not cut off. Its live events
   * are dropped until it catches up, and then the entries it missed are read back from the log (`refill`), which SPEC
   * v1 §5 allows: a reader that falls behind sees the entries it missed, not the deltas. Entries are delivered once
   * each, whichever way they came.
   */
  const watched = (sessionId: string) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        /** `undefined` marks where the subscriber fell behind. */
        const backlog = yield* Queue.unbounded<{ event?: SessionEvent; after?: string; bytes: number }>();
        let bytes = 0;
        let behind = false;
        /** The newest `state` while behind: a status, so the latest is all a subscriber needs, and the log has none. */
        let missedState: SessionEvent | undefined;
        const unwatch = port.watch(sessionId, (event, after) => {
          if (behind) {
            // Entries come back from the log and deltas are allowed lost (SPEC v1 §5). An error and a `done` are
            // neither: either can be what ends a message's stream, so neither is dropped.
            if (event.type === "serving_error" || event.type === "done")
              Queue.offerUnsafe(backlog, { event, bytes: 0 });
            if (event.type === "state") missedState = event;
            return;
          }
          const size = utf8.encode(JSON.stringify(event)).byteLength;
          if (Queue.sizeUnsafe(backlog) >= LIVE_BACKLOG.events || bytes + size > LIVE_BACKLOG.bytes) {
            behind = true;
            log.warn(
              `[fastagent] a subscriber of session ${sessionId} fell behind; it reads what it missed from the log`,
            );
            Queue.offerUnsafe(backlog, { bytes: 0 });
            return;
          }
          bytes += size;
          Queue.offerUnsafe(backlog, { event, ...(after === undefined ? {} : { after }), bytes: size });
        });
        /** The live events, after the entries `delivered` was given by the caller's own back-fill. */
        const live = (
          delivered: Delivered,
          refill: (after: string | undefined) => Stream.Stream<Entry, unknown>,
        ): Stream.Stream<SessionEvent> =>
          Stream.fromQueue(backlog).pipe(
            Stream.flatMap((queued): Stream.Stream<SessionEvent, unknown> => {
              bytes -= queued.bytes;
              const { event } = queued;
              if (event) return delivered.live(event, queued.after) ? Stream.succeed(event) : Stream.empty;
              // Resumed before the read: what is appended meanwhile is in the read, the queue, or both, and the queue's
              // copy follows an entry the read gave.
              behind = false;
              const state = missedState;
              missedState = undefined;
              return refill(delivered.last).pipe(
                Stream.map((entry): SessionEvent => {
                  delivered.read(entry);
                  return entryEvent(entry);
                }),
                Stream.concat(state ? Stream.succeed(state) : Stream.empty),
              );
            }),
            Stream.catchCause((cause) =>
              failedStream(portFailed("reading back what a subscriber missed", portError(cause))),
            ),
          );
        return { live, backlog, unwatch };
      }),
      ({ backlog, unwatch }) => Effect.sync(unwatch).pipe(Effect.andThen(Queue.shutdown(backlog))),
    );

  const asIterable = <A>(stream: Stream.Stream<A, never>): AsyncIterable<A> => Stream.toAsyncIterable(stream);

  /** A message's part of the history so far, then its live events, until its `done`. */
  const messageStream = (
    sessionId: string,
    messageId: string,
    live: Watched["live"],
    after: string | undefined,
  ): Effect.Effect<{ ok: true; events: Stream.Stream<SessionEvent> } | { ok: false; error: AgentError }> =>
    Effect.gen(function* () {
      // One read decides both what is replayed and where the live events start: a status read before it could say
      // queued for a message the backfill already shows taken, and its own entry, deduplicated, would never open it.
      const backfill = yield* fromPort(() => port.messageEntries(sessionId, messageId, after));
      if (!backfill.ok) return backfill;
      const { message } = backfill;
      const recorded = Stream.fromIterable(backfill.entries.map(entryEvent));
      if (message.status === "done" && !backfill.ended) {
        return { ok: true as const, events: Stream.concat(recorded, failedStream(unrecordedEnd(messageId))) };
      }
      if (message.status === "done") {
        return {
          ok: true as const,
          events: Stream.concat(recorded, Stream.succeed<SessionEvent>({ type: "done", message })),
        };
      }
      // A message not taken yet has nothing to follow but its own entry, which opens it.
      const delivered = deliveredFrom(
        after,
        message.status === "queued" ? (entry) => isEntryOf(messageId, entry) : undefined,
      );
      for (const entry of backfill.entries) delivered.read(entry);
      const refill = (from: string | undefined) =>
        Stream.fromEffect(fromPort(() => port.messageEntries(sessionId, messageId, from))).pipe(
          Stream.flatMap((page) =>
            page.ok ? Stream.fromIterable(page.entries) : Stream.fail(new AgentRejection(page.error)),
          ),
        );
      const fresh = live(delivered, refill).pipe(Stream.filter(forMessage(messageId)));
      // A message whose end the storage refused never sends `done`; the `serving_error` that says so ends the wait.
      const ended = (event: SessionEvent) =>
        event.type === "done"
          ? Effect.succeed(true)
          : event.type === "serving_error"
            ? fromPort(() => port.getMessage(sessionId, { messageId })).pipe(
                Effect.map((now) => now?.status === "done"),
                Effect.catchCause(() => Effect.succeed(true)),
              )
            : Effect.succeed(false);
      return { ok: true as const, events: Stream.concat(recorded, fresh).pipe(Stream.takeUntilEffect(ended)) };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({ ok: false as const, error: portFailed("reading a message", portError(cause)) }),
      ),
    );

  const invoke = (request: InvokeRequest): AsyncIterable<InvokeEvent> =>
    asIterable(
      Stream.unwrap(
        Effect.gen(function* () {
          const rejected = invalid(request);
          if (rejected) return Stream.succeed<InvokeEvent>({ type: "rejected", error: rejected });
          const sessionId = request.sessionId ?? crypto.randomUUID();
          const { live } = yield* watched(sessionId);
          const admission = yield* fromPort(() =>
            port.submit(sessionId, request.prompt, {
              whenBusy: request.whenBusy ?? "queue",
              ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
              source: request.source ?? { kind: "api" },
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({ ok: false as const, error: portFailed("invoke", portError(cause)) }),
            ),
          );
          if (!admission.ok) return Stream.succeed<InvokeEvent>({ type: "rejected", error: admission.error });
          const { message, duplicate } = admission;
          const replay = yield* messageStream(sessionId, message.messageId, live, undefined);
          const receipt: InvokeEvent = { type: "accepted", sessionId, message, duplicate };
          return Stream.concat(
            Stream.succeed(receipt),
            replay.ok ? replay.events : failedStream(replay.error),
          ) as Stream.Stream<InvokeEvent>;
        }),
      ),
    );

  const follow = (sessionId: string, after: string | undefined): AsyncIterable<FollowEvent> =>
    asIterable(
      Stream.unwrap(
        Effect.gen(function* () {
          const { live } = yield* watched(sessionId);
          const delivered = deliveredFrom(after);
          const load = (cursor: string | null) =>
            fromPort(() => port.read(sessionId, { after: cursor, limit: LIMITS.readMax }));
          const first = yield* load(after ?? null);
          if (!first.ok) return Stream.succeed<FollowEvent>({ type: "rejected", error: first.error });
          type Loaded = Extract<PortRead, { ok: true }>;
          /** The entries from a page already loaded, or from a cursor, one page at a time. */
          const pages = (start: { page: Loaded } | { cursor: string | null }): Stream.Stream<Entry, unknown> =>
            Stream.paginate<{ page: Loaded } | { cursor: string | null }, Entry, unknown>(start, (state) =>
              Effect.gen(function* () {
                const page = "page" in state ? state.page : yield* load(state.cursor);
                if (!page.ok) return yield* Effect.fail(new AgentRejection(page.error));
                const last = page.entries.at(-1);
                return [
                  page.entries,
                  page.more.after && last ? Option.some({ cursor: last.id }) : Option.none(),
                ] as const;
              }),
            );
          const backfill = pages({ page: first }).pipe(
            Stream.map((entry): SessionEvent => {
              delivered.read(entry);
              return entryEvent(entry);
            }),
          );
          const refill = (from: string | undefined) => pages({ cursor: from ?? null });
          return Stream.concat(backfill, live(delivered, refill)) as Stream.Stream<FollowEvent, unknown>;
        }).pipe(Effect.catchCause((cause) => Effect.succeed(followFailed(portError(cause))))),
      ).pipe(Stream.catchCause((cause) => followFailed(portError(cause)))),
    );

  const read = async (
    sessionId: string,
    options: { after?: string; before?: string; limit?: number },
  ): Promise<ReadResult> => {
    const limit = options.limit ?? LIMITS.readDefault;
    if (!Number.isInteger(limit) || limit < 0 || limit > LIMITS.readMax) {
      return failure("invalid_request", `limit is an integer from 0 to ${LIMITS.readMax}`);
    }
    if (options.after !== undefined && options.before !== undefined) {
      return failure("invalid_request", "a read takes after or before, not both");
    }
    const page: Page =
      options.after !== undefined ? { after: options.after, limit } : { before: options.before ?? null, limit };
    const result = await settle("read")(port.read(sessionId, page));
    if (!result.ok) return result;
    const keepNewest = !("after" in page);
    const entries = withinBudget(result.entries, keepNewest);
    const trimmed = entries.length < result.entries.length;
    const before = result.more.before || (trimmed && keepNewest);
    const after = result.more.after || (trimmed && !keepNewest);
    const first = entries[0];
    const last = entries.at(-1);
    return {
      ok: true,
      state: result.state,
      entries,
      ...(after && last ? { next: last.id } : {}),
      ...(before && first ? { prev: first.id } : {}),
    };
  };

  const unaddressable = (sessionId: string) =>
    failure("invalid_request", `session id ${JSON.stringify(sessionId)} cannot be addressed`);

  const session = (sessionId: string): Session => {
    const checked = <T extends Result | ReadResult | { ok: boolean }>(
      work: () => Promise<T>,
    ): Promise<T | { ok: false; error: AgentError }> =>
      isAddressable(sessionId) ? work() : Promise.resolve(unaddressable(sessionId));
    const rejectedStream = (error: AgentError): AsyncIterable<FollowEvent> =>
      asIterable(Stream.succeed<FollowEvent>({ type: "rejected", error }));
    return {
      sessionId,
      read: (options = {}) => checked(() => read(sessionId, options)),
      follow: (options = {}) =>
        isAddressable(sessionId) ? follow(sessionId, options.after) : rejectedStream(unaddressable(sessionId).error),
      attachment: (ref) =>
        isAddressable(sessionId)
          ? rejectRead("reading an attachment")(port.attachment(sessionId, ref))
          : Promise.resolve(undefined),
      abort: () => checked(() => settle("abort")(port.abort(sessionId))),
      rewind: (entryId) => checked(() => settle("rewind")(port.rewind(sessionId, entryId))),
      compact: (options) => checked(() => settle("compact")(port.compact(sessionId, options))),
      update: (settings) => checked(() => settle("update")(port.update(sessionId, settings))),
      delete: () => checked(() => settle("delete")(port.delete(sessionId))),
      messages: {
        get: (key) =>
          isAddressable(sessionId)
            ? rejectRead("reading a message")(port.getMessage(sessionId, key))
            : Promise.resolve(undefined),
        cancel: (messageId) => checked(() => settle("cancel")(port.cancelMessage(sessionId, messageId))),
        follow: (messageId, options = {}) => {
          if (!isAddressable(sessionId)) return rejectedStream(unaddressable(sessionId).error);
          return asIterable(
            Stream.unwrap(
              Effect.gen(function* () {
                const { live } = yield* watched(sessionId);
                const replay = yield* messageStream(sessionId, messageId, live, options.after);
                return replay.ok
                  ? (replay.events as Stream.Stream<FollowEvent>)
                  : Stream.succeed<FollowEvent>({ type: "rejected", error: replay.error });
              }),
            ),
          );
        },
      },
    };
  };

  return {
    invoke,
    sessions: {
      create: async (options = {}) => {
        const sessionId = options.sessionId ?? crypto.randomUUID();
        if (!isAddressable(sessionId)) return unaddressable(sessionId);
        if (options.fork && !isAddressable(options.fork.sessionId)) return unaddressable(options.fork.sessionId);
        const result = await settle("create")(port.create(sessionId, options.fork));
        return result.ok ? { ok: true, sessionId } : result;
      },
      list: () => rejectRead("listing sessions")(port.list()),
      get: session,
    },
    info: () => ({ protocolVersion: "1.0", capabilities: port.capabilities }),
    models: () => rejectRead("listing models")(port.models()),
    commands: () => rejectRead("listing commands")(port.commands()),
  };
}
