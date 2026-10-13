/**
 * The serving layer: the SPEC v1 `Agent` over any harness port, written once (docs/design/agent-service.md §9.1). It
 * owns what is the same for every harness: naming sessions, the request rules a type cannot carry, the invoke stream
 * (a receipt, then the run replayed from its first entry), `follow`, and pages of `read`.
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

const unrecordedEnd = (runId: string): AgentError =>
  agentError("internal", `run ${runId} has no recorded end; it reads as interrupted`);

const failedStream = (error: AgentError): Stream.Stream<SessionEvent> =>
  Stream.succeed({ type: "serving_error", message: error.message });

/** A follow's page the port refused (the session went away mid-way) is an answer, not a harness failure. */
const followFailed = (cause: unknown): Stream.Stream<SessionEvent> =>
  cause instanceof AgentRejection
    ? Stream.succeed({ type: "serving_error", message: cause.message })
    : failedStream(portFailed("follow", cause));

const entryEvent = (entry: Entry): SessionEvent => ({ type: "entry", entry });

const belongsTo =
  (runId: string) =>
  (event: SessionEvent): boolean => {
    switch (event.type) {
      case "entry":
        return event.entry.runId === runId;
      case "serving_error":
        return true;
      case "state":
        return false;
      default:
        return event.runId === runId;
    }
  };

const endsRun =
  (runId: string) =>
  (event: SessionEvent): boolean =>
    event.type === "entry" && event.entry.kind === "run_ended" && event.entry.runId === runId;

const utf8 = new TextEncoder();

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
  /** Subscribed before anything is read, so nothing appended in between is missed. */
  const watched = (sessionId: string) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<SessionEvent>();
        const unwatch = port.watch(sessionId, (event) => {
          Queue.offerUnsafe(queue, event);
        });
        return { queue, unwatch };
      }),
      ({ queue, unwatch }) => Effect.sync(unwatch).pipe(Effect.andThen(Queue.shutdown(queue))),
    );

  const asIterable = <A>(stream: Stream.Stream<A, never>): AsyncIterable<A> => Stream.toAsyncIterable(stream);

  /** A run's entries so far, then its live events, until its `run_ended`. */
  const runStream = (
    sessionId: string,
    runId: string,
    live: Queue.Queue<SessionEvent>,
    after: string | undefined,
  ): Effect.Effect<{ ok: true; events: Stream.Stream<SessionEvent> } | { ok: false; error: AgentError }> =>
    Effect.gen(function* () {
      const run = yield* fromPort(() => port.getRun(sessionId, { runId }));
      if (!run) return failure("not_found", `no run ${runId}`);
      const backfill = yield* fromPort(() => port.runEntries(sessionId, runId, after));
      if (!backfill.ok) return backfill;
      const recorded = Stream.fromIterable(backfill.entries.map(entryEvent));
      const hasEnd = (entries: Entry[]) => entries.some((entry) => entry.kind === "run_ended");
      if (run.status === "done" && !hasEnd(backfill.entries)) {
        // Either its end lies before the cursor, or the storage refused to record it.
        const whole = after === undefined ? backfill : yield* fromPort(() => port.runEntries(sessionId, runId));
        if (whole.ok && hasEnd(whole.entries)) return { ok: true as const, events: recorded };
        return { ok: true as const, events: Stream.concat(recorded, failedStream(unrecordedEnd(runId))) };
      }
      const seen = new Set(backfill.entries.map((entry) => entry.id));
      const fresh = Stream.fromQueue(live).pipe(
        Stream.filter(belongsTo(runId)),
        Stream.filter((event) => event.type !== "entry" || !seen.has(event.entry.id)),
      );
      // A run whose end the storage refused never sends `run_ended`; the `serving_error` that says so ends the wait.
      const ended = (event: SessionEvent) =>
        endsRun(runId)(event)
          ? Effect.succeed(true)
          : event.type === "serving_error"
            ? fromPort(() => port.getRun(sessionId, { runId })).pipe(
                Effect.map((now) => now?.status === "done"),
                Effect.catchCause(() => Effect.succeed(true)),
              )
            : Effect.succeed(false);
      return { ok: true as const, events: Stream.concat(recorded, fresh).pipe(Stream.takeUntilEffect(ended)) };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({ ok: false as const, error: portFailed("reading a run", portError(cause)) }),
      ),
    );

  const invoke = (request: InvokeRequest): AsyncIterable<InvokeEvent> =>
    asIterable(
      Stream.unwrap(
        Effect.gen(function* () {
          const rejected = invalid(request);
          if (rejected) return Stream.succeed<InvokeEvent>({ type: "rejected", error: rejected });
          const sessionId = request.sessionId ?? crypto.randomUUID();
          const { queue } = yield* watched(sessionId);
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
          const { run, joined, duplicate } = admission;
          const replay = yield* runStream(sessionId, run.runId, queue, undefined);
          const receipt: InvokeEvent = { type: "accepted", sessionId, run, joined, duplicate };
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
          const { queue } = yield* watched(sessionId);
          const seen = new Set<string>();
          const load = (cursor: string | null) =>
            fromPort(() => port.read(sessionId, { after: cursor, limit: LIMITS.readMax }));
          const first = yield* load(after ?? null);
          if (!first.ok) return Stream.succeed<FollowEvent>({ type: "rejected", error: first.error });
          type Loaded = Extract<PortRead, { ok: true }>;
          const backfill = Stream.paginate<Loaded | string, SessionEvent, unknown>(first, (state) =>
            Effect.gen(function* () {
              const page = typeof state === "string" ? yield* load(state) : state;
              if (!page.ok) return yield* Effect.fail(new AgentRejection(page.error));
              for (const entry of page.entries) seen.add(entry.id);
              const last = page.entries.at(-1);
              return [
                page.entries.map(entryEvent),
                page.more.after && last ? Option.some<Loaded | string>(last.id) : Option.none<Loaded | string>(),
              ] as const;
            }),
          );
          return Stream.concat(
            backfill,
            Stream.fromQueue(queue).pipe(Stream.filter((event) => event.type !== "entry" || !seen.has(event.entry.id))),
          ) as Stream.Stream<FollowEvent, unknown>;
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
      runs: {
        get: (key) =>
          isAddressable(sessionId)
            ? rejectRead("reading a run")(port.getRun(sessionId, key))
            : Promise.resolve(undefined),
        cancel: (runId) => checked(() => settle("cancel")(port.cancelRun(sessionId, runId))),
        follow: (runId, options = {}) => {
          if (!isAddressable(sessionId)) return rejectedStream(unaddressable(sessionId).error);
          return asIterable(
            Stream.unwrap(
              Effect.gen(function* () {
                const { queue } = yield* watched(sessionId);
                const replay = yield* runStream(sessionId, runId, queue, options.after);
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
