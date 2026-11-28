/**
 * `pi-durable` message admission, waiting, and streaming over the Agent API (`messages.send`, `messages.stream`,
 * `messages.get`), extracted from `agent.ts` to keep admission/waiting mechanics cohesive and separate from session CRUD.
 */
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  ConversationBusy,
  type Harness,
  InboxDoc,
  type ModelRef,
  type RegistryReader,
  type Submission,
} from "@earendil-works/pi-durable";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  type Agent,
  type AgentError,
  type AgentInfo,
  type Entry,
  LIMITS,
  type Message,
  MessageKey,
  SendRequest,
  type SessionEvent,
  Wait,
  type WaitOptions,
  agentError,
  hasEnded as messageHasEnded,
} from "@fastagent-sh/client/agent-api";
import { messageStream } from "@fastagent-sh/client/stream";
import type { WorkTracker } from "../../busy.ts";
import { type PromiseFailure, abortThenJoin, fromPromise, originalError } from "../../promise-bridge.ts";
import { type AgentCommand, expandPromptCommand } from "../text.ts";
import { type Defaults, type Unanswerable, admitSettings } from "./defaults.ts";
import { USER_ENTRY, type UserEntryData } from "./entries.ts";
import type { Ids } from "./ids.ts";
import { type InputRecord, MetadataDoc, SessionMetaDoc, isInput, queuedInputs, requestIdFor } from "./messages.ts";
import type { Reads } from "./reads.ts";

/** A wait its Caller's signal let go of: the call rejects with the signal's reason, and the message goes on. */
export class Released {
  readonly reason: unknown;
  constructor(reason: unknown) {
    this.reason = reason;
  }
}

export const released = (signal: AbortSignal): Effect.Effect<never, Released> =>
  Effect.callback<never, Released>((resume) => {
    const onAbort = () => resume(Effect.fail(new Released(signal.reason)));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

/** An input as `schema` reads it, or `invalid_request` saying where it is not. */
export const decodeInput = <A>(
  schema: Schema.Codec<A, unknown>,
  input: unknown,
  what: string,
): Exit.Exit<A, AgentError> =>
  Exit.mapError(Schema.decodeUnknownExit(schema)(input), (error) =>
    agentError("invalid_request", `${what}: ${error.message.replace(/\s*\n\s*/g, " ")}`),
  );

/**
 * A message not yet settled is the instance's work in flight: what `dev`'s restart and `busy()` wait for.
 * Whatever ends the wait, settling or the harness closing, ends the count.
 */
export function countUntilSettled(submission: Submission, work: WorkTracker): void {
  const done = work.begin();
  submission.wait(BACKGROUND_CONTEXT).then(done, done);
}

/** An iterable whose first read rejects with `error`: an operation refused before it began. */
function failing(error: unknown): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(error),
      return: async () => ({ done: true as const, value: undefined }),
    }),
  };
}

export interface MessageApiDeps {
  readonly harness: Harness;
  readonly ids: Ids;
  readonly reads: Reads;
  readonly context: Context;
  readonly work: WorkTracker;
  readonly models: Models;
  readonly registry: RegistryReader;
  readonly defaults: Defaults;
  readonly unusableDefault: NonNullable<AgentInfo["unusableDefault"]> | undefined;
  readonly commands: () => readonly AgentCommand[];
  readonly conversationOf: (sessionId: string) => Effect.Effect<Conversation, AgentError | PromiseFailure>;
  readonly failureOf: (error: unknown) => AgentError;
  readonly settle: <A>(program: Effect.Effect<A, AgentError | PromiseFailure | Released>) => Promise<A>;
  readonly events: (sessionId: string, after?: string) => AsyncIterable<SessionEvent>;
  readonly entry: (sessionId: string, entryId: string) => Promise<Entry>;
  readonly entries: Agent["sessions"]["entries"];
}

export function createPiDurableMessages(deps: MessageApiDeps): Agent["messages"] {
  const {
    harness,
    ids,
    reads,
    context,
    work,
    models,
    registry,
    defaults,
    unusableDefault,
    commands,
    conversationOf,
    failureOf,
    settle,
    events,
    entry,
    entries,
  } = deps;
  const admission = Semaphore.makeUnsafe(1);

  const inFlight = fromPromise(() => harness.inspect(context)).pipe(
    Effect.map(({ submissions }) => submissions.filter((record) => record.type === "input").length),
  );

  const hasTool = (name: string): boolean =>
    registry
      .snapshot()
      .tools()
      .some(({ tool }) => tool.name === name);
  const has = {
    model: (model: ModelRef) => models.getModel(model.provider, model.modelId) !== undefined,
    tool: hasTool,
  };

  /** A message no setting of its session could answer is refused, recording nothing, rather than accepted to fail. */
  const unanswerable = (refused: Unanswerable): AgentError => {
    if (refused.missing === "tools") {
      const names = refused.tools.join(", ");
      return agentError("missing_tool", `This session enables ${names}, which this agent no longer has`, {
        tools: refused.tools,
      });
    }
    const { model } = refused;
    return agentError(
      "missing_model",
      model === undefined
        ? unusableDefault === undefined
          ? "Neither this session nor the agent names a model"
          : `This session names no model, and the agent's default ${unusableDefault.spec} is unusable: ${unusableDefault.reason}`
        : `This session answers with ${model.provider}/${model.modelId}, which is not among this agent's models`,
      model === undefined ? undefined : { model: `${model.provider}/${model.modelId}` },
    );
  };

  const unconfirmed = (conversation: Conversation, messageId: number | undefined, error: unknown): AgentError =>
    agentError(
      "unconfirmed",
      `${messageId === undefined ? "The message may have been recorded, and that could not be confirmed" : "The message was recorded, and reading it back failed"}: ${failureOf(error).message}`,
      {
        sessionId: ids.encode(conversation.id),
        ...(messageId === undefined ? {} : { messageId: ids.encode(messageId) }),
      },
    );

  /**
   * Admission, one at a time per process: one commit that looks the key up, then checks the process's limit and the
   * queue, takes the defaults and submits, so it stores all of that or none of it.
   */
  const admit = (
    request: SendRequest,
  ): Effect.Effect<{ message: Message; replayed: boolean }, AgentError | PromiseFailure> =>
    Semaphore.withPermits(
      admission,
      1,
    )(
      Effect.gen(function* () {
        const requestId = requestIdFor(request.idempotencyKey);
        // Before anything is written: reading or expanding a command reads the definition's files, and may throw.
        const { content, sent } = expandPromptCommand(request.content, commands());
        const conversation = yield* conversationOf(request.sessionId);
        // Read before the commit, which cannot read the harness, and applied after the key: a key the session has
        // seen answers with its message whatever the process holds.
        const atCapacity = (yield* inFlight) >= LIMITS.inFlightPerProcess;
        const data: UserEntryData = { requestId, ...(sent === undefined ? {} : { sent }) };
        let submitting = false;
        const admitted = yield* fromPromise(() =>
          conversation.commit(async (tx) => {
            const meta = await tx.doc(SessionMetaDoc, conversation.id);
            if (meta.deleted) return { kind: "deleted" } as const;
            if (request.idempotencyKey !== undefined) {
              const seen = await tx.submissionByRequest(conversation.id, requestId);
              if (isInput(seen)) return { kind: "seen", seen } as const;
            }
            if (atCapacity) return { kind: "capacity" } as const;
            if (request.whenBusy !== "reject") {
              const inbox = await tx.doc(InboxDoc, conversation.id);
              if (queuedInputs(inbox).length >= LIMITS.queuedPerSession) return { kind: "full" } as const;
            }
            const refused = await admitSettings(tx, conversation.id, defaults, has);
            if (refused !== undefined) return { kind: "refused", refused } as const;
            submitting = true;
            const id = await conversation.admit(tx, {
              type: "input",
              content,
              requestId,
              whenBusy: request.whenBusy === "steer" ? "steer" : request.whenBusy === "reject" ? "reject" : "followUp",
              entry: { kind: USER_ENTRY, data },
            });
            if (request.metadata !== undefined) {
              (await tx.doc(MetadataDoc, String(id), null)).metadata = { ...request.metadata };
            }
            meta.updatedAt = Date.now();
            return { kind: "admitted", id } as const;
          }, context),
        ).pipe(
          // Once the submission is in the commit, only pi-durable's explicit refusal proves nothing was recorded.
          Effect.catchCause((cause): Effect.Effect<never, AgentError | PromiseFailure> => {
            const error = originalError(cause);
            if (error instanceof ConversationBusy) {
              return Effect.fail(agentError("busy", "The session is answering another message", { reason: "running" }));
            }
            return submitting ? Effect.fail(unconfirmed(conversation, undefined, error)) : Effect.failCause(cause);
          }),
        );
        if (admitted.kind === "deleted") {
          return yield* agentError("not_found", `No session ${request.sessionId}`);
        }
        if (admitted.kind === "seen") return { message: yield* reads.message(admitted.seen), replayed: true };
        if (admitted.kind === "capacity") {
          return yield* agentError("busy", `This agent already holds ${LIMITS.inFlightPerProcess} messages`, {
            reason: "capacity",
          });
        }
        if (admitted.kind === "full") {
          return yield* agentError("busy", `The session already has ${LIMITS.queuedPerSession} queued messages`, {
            reason: "queue_full",
          });
        }
        if (admitted.kind === "refused") return yield* unanswerable(admitted.refused);
        const messageId = admitted.id;
        return yield* Effect.gen(function* () {
          const submission = yield* fromPromise(() => harness.submission(messageId, context));
          if (submission === undefined) {
            throw new Error(`submission ${messageId} is not in the storage it was admitted to`);
          }
          // Counted once it is read back, whether or not that read succeeds: the wait must not be what reads the
          // storage first, or a failing read would fail it instead of answering this call.
          const record = yield* fromPromise(() => submission.status(context)).pipe(
            Effect.ensuring(Effect.sync(() => countUntilSettled(submission, work))),
          );
          if (!isInput(record)) throw new Error(`submission ${record.id} was admitted as a write`);
          return { message: yield* reads.message(record), replayed: false };
        }).pipe(Effect.catchCause((cause) => Effect.fail(unconfirmed(conversation, messageId, originalError(cause)))));
      }),
    );

  /** The message as it is now. */
  const current = (message: Message): Effect.Effect<Message, PromiseFailure> =>
    reads.submission(message.id).pipe(
      Effect.flatMap((record) => {
        if (record === undefined) throw new Error(`message ${message.id} is not in the storage it was accepted into`);
        return reads.message(record);
      }),
    );

  /** The message once it has ended, or after `seconds` as it is then; `signal` lets go of the wait. */
  const awaitEnd = (
    message: Message,
    seconds: number,
    signal: AbortSignal | undefined,
  ): Effect.Effect<Message, PromiseFailure | Released> => {
    if (messageHasEnded(message) || seconds === 0) return Effect.succeed(message);
    const ended = fromPromise(() => harness.submission(ids.decode(message.id) as Submission["id"], context)).pipe(
      Effect.flatMap((handle) => {
        if (handle === undefined) throw new Error(`message ${message.id} is not in the storage it was accepted into`);
        const controller = new AbortController();
        return abortThenJoin(
          "a message's wait",
          () => handle.wait(withAbortSignal(controller.signal, context)),
          () => controller.abort(),
        );
      }),
      Effect.flatMap((record) => reads.message(record as InputRecord)),
    );
    const timed = ended.pipe(
      Effect.timeoutOption(Duration.seconds(seconds)),
      Effect.flatMap(Option.match({ onNone: () => current(message), onSome: Effect.succeed })),
    );
    return signal === undefined ? timed : Effect.raceFirst(timed, released(signal));
  };

  const send = (request: SendRequest, sendOptions?: WaitOptions): Promise<Message> =>
    settle(
      Effect.gen(function* () {
        const decoded = yield* decodeInput(SendRequest, request, "messages.send");
        const seconds =
          sendOptions?.wait === undefined ? undefined : yield* decodeInput(Wait, sendOptions.wait, "wait");
        const signal = sendOptions?.signal;
        // A send whose Caller let go before it was made is not made, as `fetch` does not send one.
        if (signal?.aborted) return yield* Effect.fail(new Released(signal.reason));
        const { message } = yield* admit(decoded);
        if (seconds === undefined) return message;
        return yield* awaitEnd(message, seconds, signal).pipe(
          Effect.catchCause((cause): Effect.Effect<never, AgentError | Released> => {
            const error = originalError(cause);
            if (error instanceof Released) return Effect.fail(error);
            return Effect.fail(
              agentError(
                "unconfirmed",
                `The message was recorded, and waiting for it failed: ${failureOf(error).message}`,
                {
                  sessionId: message.sessionId,
                  messageId: message.id,
                },
              ),
            );
          }),
        );
      }),
    );

  const get = (key: MessageKey, getOptions?: WaitOptions): Promise<Message> =>
    settle(
      Effect.gen(function* () {
        const decoded = yield* decodeInput(MessageKey, key, "messages.get");
        const seconds = getOptions?.wait === undefined ? undefined : yield* decodeInput(Wait, getOptions.wait, "wait");
        const signal = getOptions?.signal;
        if (signal?.aborted) return yield* Effect.fail(new Released(signal.reason));
        const conversation = yield* conversationOf(decoded.sessionId);
        const record =
          "messageId" in decoded
            ? yield* reads.submission(decoded.messageId)
            : yield* reads.submissionByKey(conversation, requestIdFor(decoded.idempotencyKey));
        if (record === undefined || record.conversationId !== conversation.id) {
          const which = "messageId" in decoded ? decoded.messageId : `with key ${decoded.idempotencyKey}`;
          return yield* agentError("not_found", `No message ${which} in session ${decoded.sessionId}`);
        }
        const message = yield* reads.message(record);
        return seconds === undefined ? message : yield* awaitEnd(message, seconds, signal);
      }),
    );

  const stream: Agent["messages"]["stream"] = (request, streamOptions) => {
    const decoded = decodeInput(SendRequest, request, "messages.stream");
    if (Exit.isFailure(decoded)) return failing(Cause.squash(decoded.cause));
    return messageStream(
      {
        events,
        admit: (sent) => settle(admit(sent)),
        get: (sessionId, messageId) => get({ sessionId, messageId }),
        entry,
        entries,
      },
      decoded.value,
      streamOptions?.signal,
    );
  };

  return { send, stream, get };
}
