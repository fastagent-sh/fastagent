/**
 * The Agent API (SPEC.md) over pi-durable: a Harness opened on the instance's storage, and the operations read
 * from and submitted to it. Admission (a key's lookup, the limits and the submission) is one step per process, since
 * one process owns a storage.
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ImageContent, Models, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  AgentDoc,
  type Conversation,
  ConversationBusy,
  DEFAULT_RETRY_POLICY,
  type EntryRecord,
  Harness,
  type HarnessOptions,
  type HarnessSettings,
  InboxDoc,
  LiveDoc,
  type ModelRef,
  type RegistryReader,
  SessionFailed,
  type Storage,
  type Submission,
  type ToolRegistration,
  configure,
} from "@earendil-works/pi-durable";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  type Agent,
  AgentError,
  type AgentInfo,
  CompactOptions,
  CreateSessionOptions,
  type Entry,
  EntriesOptions,
  LIMITS,
  ListOptions,
  type Message,
  MessageKey,
  type Page,
  SendRequest,
  type Session,
  SessionChanges,
  Wait,
  type WaitOptions,
  agentError,
  hasEnded as messageHasEnded,
} from "../../agent-api.ts";
import { beginWork } from "../../channels/busy.ts";
import { type PortFailure, port, portAbort, portError } from "../../effect-port.ts";
import { log } from "../../log.ts";
import { type Defaults, type Unanswerable, admitSettings } from "./defaults.ts";
import { USER_ENTRY, type UserEntryData, imageAt, isPublished, parseImageRef } from "./entries.ts";
import { sessionEvents } from "./events.ts";
import { type Ids, storageIds } from "./ids.ts";
import { giveUpOnParked, parkedTasks } from "./parked.ts";
import { type InputRecord, isInput, queuedInputs, requestIdFor, usageOfState } from "./messages.ts";
import { type Reads, durableReads } from "./reads.ts";
import { releaseWaitingQueues } from "./release.ts";
import { type Sessions, trackSessions } from "./sessions.ts";
import { messageStream } from "./stream.ts";

/** What a Caller may offer as `/<name>`: a prompt template or a skill, expanded for the model (SPEC.md §5.1). */
export interface AgentCommand {
  name: string;
  description?: string;
  expand(args: string): string;
}

export interface DurableAgentOptions {
  storage: Storage;
  models: Models;
  registry: RegistryReader;
  settings?: HarnessSettings;
  env?: HarnessOptions["env"];
  name: string;
  description?: string;
  /** Read for every `info()` and send, so a command the definition gains is offered without a restart. */
  commands?: () => readonly AgentCommand[];
  /** What a conversation answers with when its own settings name none (defaults.ts). */
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  inFlightPerProcess?: number;
  /** What becomes of the messages an earlier process accepted and did not end ({@link Unfinished}). */
  unfinished?: Unfinished;
}

/**
 * What a process does with the messages an earlier one accepted and did not end (it was stopped, or killed). `"resume"`
 * (the default, a serve's): they run on in this one, as its own work. `"abort"`: they end aborted before anything runs,
 * for a Caller whose messages do not outlive it (`fastagent invoke`), where running one again would run what its user
 * stopped. `"refuse"`: the open fails naming them, for a process that runs one thing and would cut the rest off
 * (`fastagent schedules run`).
 */
export type Unfinished = "resume" | "abort" | "refuse";

export interface DurableAgent extends Agent {
  /** pi-durable's own API, for operating the agent. */
  readonly harness: Harness;
  /** The conversation a session id names, to operate it through `harness`. */
  conversation(sessionId: string): Promise<Conversation | undefined>;
  close(): Promise<void>;
}

const OWNERLESS = { ownership: { kind: "ownerless" } } as const;
const COMMAND = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

export async function openDurableAgent(options: DurableAgentOptions): Promise<DurableAgent> {
  const context = BACKGROUND_CONTEXT;
  const parked = parkedTasks();
  const harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry: options.registry,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.env === undefined ? {} : { env: options.env }),
      onReport: (error, info) => {
        log.warn(`[fastagent] pi-durable reported: ${String(error)}`);
        parked.report(info);
      },
    },
    context,
  );
  const lifetime = Scope.makeUnsafe();
  try {
    const ids = await storageIds(harness, context);
    const sessions = await Effect.runPromise(Scope.provide(trackSessions(harness, options.storage, context), lifetime));
    await giveUpOnParked(harness, parked.tasks, context);
    // Before `resume()`, which runs an earlier process's work. An abort enables the scheduler too, but commits first, so
    // the aborted work does not run (measured).
    const unsettled = (await harness.inspect(context)).submissions.filter(isInput);
    const unfinished = options.unfinished ?? "resume";
    if (unsettled.length > 0 && unfinished !== "resume") {
      const where = [...new Set(unsettled.map((record) => record.conversationId))]
        .filter((id) => sessions.has(id))
        .map((id) => ids.encode(id));
      const said = `${unsettled.length} message(s) an earlier process accepted and stopped before they ended (sessions: ${where.join(", ")})`;
      if (unfinished === "refuse") {
        throw new Error(
          `the storage holds ${said}, which this process would not finish: serve the agent until they end, then try again`,
        );
      }
      for (const conversationId of new Set(unsettled.map((record) => record.conversationId))) {
        await (await harness.conversation(conversationId, context))?.abort(context);
      }
      log.warn(`[fastagent] aborted ${said}: none of it runs again`);
    } else {
      // What an earlier process accepted and did not settle runs on in this one: it is this process's work now.
      for (const record of unsettled) {
        const submission = await harness.submission(record.id, context);
        if (submission !== undefined) countUntilSettled(submission);
      }
    }
    harness.resume();
    await Effect.runPromise(Scope.provide(releaseWaitingQueues(harness, context), lifetime));
    return durableAgent(harness, ids, sessions, lifetime, options);
  } catch (error) {
    await Effect.runPromise(Scope.close(lifetime, Exit.void));
    await harness.close(context);
    throw error;
  }
}

/**
 * A message not yet settled is the process's work in flight (busy.ts): what AgentCore's ping and `dev`'s restart wait
 * for. Whatever ends the wait, settling or the harness closing, ends the count.
 */
function countUntilSettled(submission: Submission): void {
  const done = beginWork();
  submission.wait(BACKGROUND_CONTEXT).then(done, done);
}

/** A wait its Caller's signal let go of: the call rejects with the signal's reason, and the message goes on. */
class Released {
  readonly reason: unknown;
  constructor(reason: unknown) {
    this.reason = reason;
  }
}

const released = (signal: AbortSignal): Effect.Effect<never, Released> =>
  Effect.callback<never, Released>((resume) => {
    const onAbort = () => resume(Effect.fail(new Released(signal.reason)));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

/** An input as `schema` reads it, or `invalid_request` saying where it is not. */
const decode = <A>(schema: Schema.Codec<A, unknown>, input: unknown, what: string): Exit.Exit<A, AgentError> =>
  Exit.mapError(Schema.decodeUnknownExit(schema)(input), (error) =>
    agentError("invalid_request", `${what}: ${error.message.replace(/\s*\n\s*/g, " ")}`),
  );

function durableAgent(
  harness: Harness,
  ids: Ids,
  sessions: Sessions,
  lifetime: Scope.Closeable,
  options: DurableAgentOptions,
): DurableAgent {
  const context = BACKGROUND_CONTEXT;
  const reads = durableReads(harness, ids, sessions, context);
  const admission = Semaphore.makeUnsafe(1);
  const commands = options.commands ?? (() => []);
  const inFlightLimit = options.inFlightPerProcess ?? LIMITS.inFlightPerProcess;
  let closing = false;
  harness.subscribeClose(() => {
    closing = true;
  });

  /** A failed call as a Caller's error: once the harness is closing (its storage failed, or it was closed), `unavailable`. */
  const failureOf = (error: unknown): AgentError => {
    const message = error instanceof Error ? error.message : String(error);
    if (closing || error instanceof SessionFailed)
      return agentError("unavailable", `The agent cannot answer now: ${message}`);
    log.error(`[fastagent] the agent failed: ${error instanceof Error ? (error.stack ?? message) : message}`);
    return agentError("internal", message);
  };

  /** An operation as the Promise the API promises: what it names, or a rejection with an AgentError (§4). */
  const settle = <A>(program: Effect.Effect<A, AgentError | PortFailure | Released>): Promise<A> =>
    Effect.runPromise(
      program.pipe(
        Effect.catchCause((cause) => {
          const error = portError(cause);
          if (error instanceof Released) return Effect.fail(error.reason);
          return Effect.fail(error instanceof AgentError ? error : failureOf(error));
        }),
      ),
    );

  const conversationOf = (sessionId: string): Effect.Effect<Conversation, AgentError | PortFailure> =>
    reads
      .conversation(sessionId)
      .pipe(
        Effect.flatMap((conversation) =>
          conversation === undefined
            ? Effect.fail(agentError("not_found", `No session ${sessionId}`))
            : Effect.succeed(conversation),
        ),
      );

  /** The agent's tools by name: the registry's, read for each use, so a tool the definition gains is offered at once. */
  const toolsByName = (): Map<string, ToolRegistration> => {
    const tools = new Map<string, ToolRegistration>();
    for (const { tool } of options.registry.snapshot().tools()) if (!tools.has(tool.name)) tools.set(tool.name, tool);
    return tools;
  };

  /** What pi-durable stores for `changes`: tools by their registrations, which it stores by name. */
  const changeOf = (changes: SessionChanges): Effect.Effect<AgentChange, AgentError> =>
    Effect.suspend(() => {
      const { model, thinkingLevel, instructions, tools } = changes;
      let registrations: ToolRegistration[] | null | undefined;
      if (tools !== undefined && tools !== null) {
        const known = toolsByName();
        const unknown = tools.filter((name) => !known.has(name));
        if (unknown.length > 0) {
          return Effect.fail(
            agentError("invalid_request", `This agent has no tool named ${unknown.join(", ")}`, { tools: unknown }),
          );
        }
        registrations = tools.map((name) => known.get(name) as ToolRegistration);
      } else registrations = tools;
      return Effect.succeed({
        ...(model === undefined
          ? {}
          : { model: model === null ? null : { provider: model.provider, modelId: model.modelId } }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        ...(instructions === undefined ? {} : { instructions }),
        ...(registrations === undefined ? {} : { tools: registrations }),
      });
    });

  const info = (): Promise<AgentInfo> =>
    settle(
      Effect.gen(function* () {
        const available = yield* port(() => options.models.getAvailable());
        const named = ({ name, description }: { name: string; description?: string }) => ({
          name,
          ...(description ? { description } : {}),
        });
        return {
          name: options.name,
          ...(options.description === undefined ? {} : { description: options.description }),
          commands: commands().map(named),
          tools: [...toolsByName().values()].map(named),
          models: available.map((model) => ({
            provider: model.provider,
            modelId: model.id,
            ...(model.name ? { name: model.name } : {}),
            // pi reads a window a model does not declare (a virtual model's, before its first answer) as 0.
            ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
          })),
          ...(options.model === undefined
            ? {}
            : { defaultModel: { provider: options.model.provider, modelId: options.model.modelId } }),
        };
      }),
    );

  const inFlight = port(() => harness.inspect(context)).pipe(
    Effect.map(({ submissions }) => submissions.filter((record) => record.type === "input").length),
  );

  const defaults: Defaults = {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
  };
  const has = {
    model: (model: ModelRef) => options.models.getModel(model.provider, model.modelId) !== undefined,
    tool: (name: string) => toolsByName().has(name),
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
        ? "Neither this session nor the agent names a model"
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

  /** Admission: a key's lookup, the limits, the settings and the submission, one at a time per process. */
  const admit = (
    request: SendRequest,
  ): Effect.Effect<{ message: Message; replayed: boolean }, AgentError | PortFailure> =>
    Semaphore.withPermits(
      admission,
      1,
    )(
      Effect.gen(function* () {
        const requestId = requestIdFor(request.idempotencyKey);
        // Before anything is written: reading or expanding a command reads the definition's files, and may throw.
        const { content, sent } = expandCommand(request.content, commands());
        const conversation = yield* conversationOf(request.sessionId);
        if (request.idempotencyKey !== undefined) {
          const seen = yield* reads.submissionByKey(conversation, requestId);
          if (seen !== undefined) return { message: yield* reads.message(seen), replayed: true };
        }
        if ((yield* inFlight) >= inFlightLimit) {
          return yield* agentError("busy", `This agent already holds ${inFlightLimit} messages`, {
            reason: "capacity",
          });
        }
        if (request.whenBusy !== "reject") {
          const inbox = yield* reads.inbox(conversation);
          if (queuedInputs(inbox).length >= LIMITS.queuedPerSession) {
            return yield* agentError("busy", `The session already has ${LIMITS.queuedPerSession} queued messages`, {
              reason: "queue_full",
            });
          }
        }
        const refused = yield* port(() =>
          conversation.commit((tx) => admitSettings(tx, conversation.id, defaults, has), context),
        );
        if (refused !== undefined) return yield* unanswerable(refused);
        const data: UserEntryData = { requestId, ...(sent === undefined ? {} : { sent }) };
        let messageId: number | undefined;
        return yield* Effect.gen(function* () {
          const submission = yield* port(() =>
            conversation.submit(
              {
                type: "input",
                content,
                requestId,
                whenBusy:
                  request.whenBusy === "steer" ? "steer" : request.whenBusy === "reject" ? "reject" : "followUp",
                entry: { kind: USER_ENTRY, data },
              },
              context,
            ),
          );
          messageId = submission.id;
          // Counted once it is read back, whether or not that read succeeds: the wait must not be what reads the
          // storage first, or a failing read would fail it instead of answering this call.
          const record = yield* port(() => submission.status(context)).pipe(
            Effect.ensuring(Effect.sync(() => countUntilSettled(submission))),
          );
          if (!isInput(record)) throw new Error(`submission ${record.id} was admitted as a write`);
          return { message: yield* reads.message(record), replayed: false };
        }).pipe(
          // Once submission starts, only pi-durable's explicit refusal proves nothing was recorded.
          Effect.catchCause((cause) => {
            const error = portError(cause);
            return Effect.fail(
              messageId === undefined && error instanceof ConversationBusy
                ? agentError("busy", "The session is answering another message", { reason: "running" })
                : unconfirmed(conversation, messageId, error),
            );
          }),
        );
      }),
    );

  /** The message as it is now. */
  const current = (message: Message): Effect.Effect<Message, PortFailure> =>
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
  ): Effect.Effect<Message, PortFailure | Released> => {
    if (messageHasEnded(message) || seconds === 0) return Effect.succeed(message);
    const ended = port(() => harness.submission(ids.decode(message.id) as Submission["id"], context)).pipe(
      Effect.flatMap((handle) => {
        if (handle === undefined) throw new Error(`message ${message.id} is not in the storage it was accepted into`);
        const controller = new AbortController();
        return portAbort(
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
        const decoded = yield* decode(SendRequest, request, "messages.send");
        const seconds = sendOptions?.wait === undefined ? undefined : yield* decode(Wait, sendOptions.wait, "wait");
        const signal = sendOptions?.signal;
        // A send whose Caller let go before it was made is not made, as `fetch` does not send one.
        if (signal?.aborted) return yield* Effect.fail(new Released(signal.reason));
        const { message } = yield* admit(decoded);
        if (seconds === undefined) return message;
        return yield* awaitEnd(message, seconds, signal).pipe(
          Effect.catchCause((cause): Effect.Effect<never, AgentError | Released> => {
            const error = portError(cause);
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
        const decoded = yield* decode(MessageKey, key, "messages.get");
        const seconds = getOptions?.wait === undefined ? undefined : yield* decode(Wait, getOptions.wait, "wait");
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

  const create = (createOptions?: CreateSessionOptions): Promise<Session> =>
    settle(
      Effect.gen(function* () {
        const { forkFrom, ...settings } = yield* decode(CreateSessionOptions, createOptions ?? {}, "sessions.create");
        const creation = { ...OWNERLESS, agent: yield* changeOf(settings) };
        if (forkFrom === undefined) {
          return yield* reads.session(yield* port(() => harness.createConversation(creation, context)));
        }
        const source = yield* conversationOf(forkFrom.sessionId);
        const at =
          forkFrom.entryId === undefined
            ? yield* reads
                .history(source, { order: "descending" })
                .pipe(Stream.runHead, Effect.map(Option.getOrUndefined))
            : yield* reads.visibleEntry(source, forkFrom.entryId);
        if (at === undefined && forkFrom.entryId !== undefined) {
          return yield* agentError("not_found", `No entry ${forkFrom.entryId} in session ${forkFrom.sessionId}`);
        }
        const fork =
          at === undefined
            ? yield* port(async () => {
                // pi-durable forks at an entry; an empty source has only settings to inherit.
                const inherited = await harness.snapshot(AgentDoc, source.id, context);
                return harness.createConversation(
                  {
                    ...creation,
                    init: async (tx, id) => {
                      Object.assign(await tx.doc(AgentDoc, id), inherited);
                      await configure(tx, id, creation.agent);
                    },
                  },
                  context,
                );
              })
            : yield* port(() => source.fork(at.id, creation, context));
        return yield* reads.session(fork);
      }),
    );

  const update = (sessionId: string, changes: SessionChanges): Promise<Session> =>
    settle(
      Effect.gen(function* () {
        const decoded = yield* decode(SessionChanges, changes, "sessions.update");
        if (Object.values(decoded).every((value) => value === undefined)) {
          return yield* agentError(
            "invalid_request",
            "Nothing to update: give a model, a thinking level, instructions or tools",
          );
        }
        const conversation = yield* conversationOf(sessionId);
        const change = yield* changeOf(decoded);
        yield* port(() => conversation.configure(change, context));
        return yield* reads.session(conversation);
      }),
    );

  const list = (listOptions?: ListOptions): Promise<Page<Session>> =>
    settle(
      Effect.gen(function* () {
        const { after, limit = LIMITS.pageDefault } = yield* decode(ListOptions, listOptions ?? {}, "sessions.list");
        const position = after === undefined ? undefined : ids.decodeCursor(after);
        if (after !== undefined && position === undefined) {
          return yield* agentError("invalid_request", `${JSON.stringify(after)} is not a cursor of this agent's`);
        }
        const ordered = sessions.byActivity();
        const rest = position === undefined ? ordered : ordered.filter(({ activity }) => activity < position);
        const page = rest.slice(0, limit);
        const last = page.at(-1);
        const data = yield* reads.sessionsOf(page.map(({ conversationId }) => conversationId));
        return {
          data,
          ...(rest.length > limit && last !== undefined ? { next: ids.encodeCursor(last.activity) } : {}),
        };
      }),
    );

  const entries = (sessionId: string, entriesOptions?: EntriesOptions): Promise<Page<Entry>> =>
    settle(
      Effect.gen(function* () {
        const decoded = yield* decode(EntriesOptions, entriesOptions ?? {}, "sessions.entries");
        if (decoded.after !== undefined && decoded.before !== undefined) {
          return yield* agentError("invalid_request", "A page is after an entry or before one, not both");
        }
        return yield* readPage(reads, yield* conversationOf(sessionId), sessionId, decoded);
      }),
    );

  /** One entry the session published, by its id: where `messages.stream` starts a message that is already running. */
  const entry = (sessionId: string, entryId: string): Promise<Entry> =>
    settle(
      Effect.gen(function* () {
        const record = yield* reads.visibleEntry(yield* conversationOf(sessionId), entryId);
        const [published] = record === undefined || !isPublished(record) ? [] : yield* reads.publish([record]);
        if (published === undefined)
          return yield* agentError("not_found", `No entry ${entryId} in session ${sessionId}`);
        return published;
      }),
    );

  const events = (sessionId: string, eventsOptions?: { after?: string; signal?: AbortSignal }) => {
    const stream = sessionEvents(
      {
        harness,
        reads,
        ids,
        context,
        failureOf,
        maxRetries: options.settings?.retry?.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
      },
      sessionId,
      eventsOptions?.after,
    );
    const signal = eventsOptions?.signal;
    return Stream.toAsyncIterable(
      signal === undefined
        ? stream
        : stream.pipe(Stream.interruptWhen(released(signal).pipe(Effect.mapError((error) => error.reason)))),
    );
  };

  /**
   * Stops everything the session is doing, and answers once that stop is recorded rather than once it has ended
   * (§4). pi-durable runs commits one at a time in the order they are called, and `abort()` calls its commit at once:
   * so the read before it sees what it stops, and the check after it runs once the stop is in the storage.
   */
  const cancel = (sessionId: string): Promise<{ stopped: string[] }> =>
    settle(
      Effect.gen(function* () {
        const conversation = yield* conversationOf(sessionId);
        let abortFailed: unknown;
        const recorded = yield* port(() => {
          const before = harness.commit(async (tx) => {
            // Copied out: a document read in a transaction cannot be read once it has settled.
            const run = (await tx.doc(LiveDoc, conversation.id))?.run;
            return {
              run: run === undefined ? undefined : { taskId: run.taskId, inputs: [...run.inputs] },
              queued: queuedInputs(await tx.doc(InboxDoc, conversation.id)),
            };
          }, context);
          conversation.abort(context).catch((error: unknown) => {
            abortFailed = error;
            if (!closing) log.warn(`[fastagent] stopping session ${sessionId} failed: ${String(error)}`);
          });
          const check = harness.commit(async (tx) => {
            const { run, queued } = await before;
            const task = run === undefined ? undefined : await tx.task(run.taskId);
            const stillQueued = new Set(queuedInputs(await tx.doc(InboxDoc, conversation.id)));
            return {
              marked:
                (task === undefined || task.abortRequested || task.state.status === "terminal") &&
                queued.every((id) => !stillQueued.has(id)),
              stopped: [...(run?.inputs ?? []), ...queued],
            };
          }, context);
          // Both, so a harness that refuses every commit (closing, or its storage failed) fails this cancel once,
          // leaving neither refusal unheard: the check's callback, which awaits the read, never runs then.
          return Promise.all([before, check]).then(([, checked]) => checked);
        });
        if (!recorded.marked) {
          throw new Error(
            `the stop of session ${sessionId} was not recorded: ${String(abortFailed ?? "no reason given")}`,
          );
        }
        return { stopped: recorded.stopped.map((id) => ids.encode(id)) };
      }),
    );

  const compact = (sessionId: string, compactOptions?: CompactOptions): Promise<void> =>
    settle(
      Effect.gen(function* () {
        const { instructions } = yield* decode(CompactOptions, compactOptions ?? {}, "sessions.compact");
        const conversation = yield* conversationOf(sessionId);
        yield* port(() => conversation.compact(instructions, context));
      }),
    );

  const attachment = (sessionId: string, ref: string): Promise<{ mimeType: string; data: Uint8Array }> =>
    settle(
      Effect.gen(function* () {
        const missing = agentError("not_found", `No attachment ${ref} in session ${sessionId}`);
        const parsed = parseImageRef(ref);
        if (parsed === undefined) return yield* missing;
        const record = yield* reads.visibleEntry(yield* conversationOf(sessionId), parsed.entryId);
        const image = record === undefined ? undefined : imageAt(record, parsed.index);
        if (image === undefined) return yield* missing;
        return { mimeType: image.mimeType, data: new Uint8Array(Buffer.from(image.data, "base64")) };
      }),
    );

  const stream: Agent["messages"]["stream"] = (request, streamOptions) => {
    const decoded = decode(SendRequest, request, "messages.stream");
    if (Exit.isFailure(decoded)) return failing(Cause.squash(decoded.cause));
    return messageStream(
      {
        events: (sessionId, after) => events(sessionId, after === undefined ? {} : { after }),
        admit: (sent) => settle(admit(sent)),
        get: (sessionId, messageId) => get({ sessionId, messageId }),
        entry,
        entries,
      },
      decoded.value,
      streamOptions?.signal,
    );
  };

  return {
    harness,
    info,
    usage: () => settle(port(() => harness.usage(context)).pipe(Effect.map((spent) => usageOfState(spent)))),
    sessions: {
      create,
      get: (sessionId) => settle(conversationOf(sessionId).pipe(Effect.flatMap(reads.session))),
      list,
      update,
      entries,
      events,
      cancel,
      compact,
      attachment,
    },
    messages: { send, stream, get },
    conversation: (sessionId) => Effect.runPromise(reads.conversation(sessionId)),
    close: async () => {
      closing = true;
      await Effect.runPromise(Scope.close(lifetime, Exit.void));
      await harness.close(context);
    },
  };
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

/** The content the model sees, and the first text as sent when it was a command the agent expanded. */
function expandCommand(
  content: SendRequest["content"],
  commands: readonly AgentCommand[],
): { content: (TextContent | ImageContent)[]; sent?: string } {
  const parts = (typeof content === "string" ? [{ type: "text" as const, text: content }] : content).map(
    (part): TextContent | ImageContent =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", mimeType: part.mimeType, data: part.data },
  );
  const first = parts[0];
  const match = first?.type === "text" ? COMMAND.exec(first.text) : null;
  const command = match === null ? undefined : commands.find(({ name }) => name === match[1]);
  if (first?.type !== "text" || match === null || command === undefined) return { content: parts };
  return { content: [{ type: "text", text: command.expand(match[2] ?? "") }, ...parts.slice(1)], sent: first.text };
}

/** One page of a session's published entries (§4): after a cursor, before one, or the newest. */
function readPage(
  reads: Reads,
  conversation: Conversation,
  sessionId: string,
  { after, before, limit = LIMITS.pageDefault }: EntriesOptions,
): Effect.Effect<Page<Entry>, AgentError | PortFailure> {
  return Effect.gen(function* () {
    const cursor = after ?? before;
    const at = cursor === undefined ? undefined : yield* reads.visibleEntry(conversation, cursor);
    if (cursor !== undefined && at === undefined) {
      return yield* agentError("not_found", `No entry ${cursor} in session ${sessionId}`);
    }
    const bound = (id: number) => id as EntryRecord["id"];
    const take = (query: Parameters<Reads["published"]>[1]) =>
      reads.published(conversation, query).pipe(Stream.take(limit + 1), Stream.runCollect);

    if (after !== undefined && at !== undefined) {
      const records = yield* take({ order: "ascending", minEntryId: bound(at.id + 1) });
      const page = records.slice(0, limit);
      const first = page[0];
      if (first === undefined) return { data: [] };
      const earlier = yield* reads.newestPublished(conversation, first.id - 1);
      const data = withinBudget(yield* reads.publish(page), "oldest");
      return {
        data,
        ...(earlier === undefined ? {} : { prev: (data[0] as Entry).id }),
        ...(records.length > limit || data.length < page.length ? { next: (data.at(-1) as Entry).id } : {}),
      };
    }

    const records = yield* take({
      order: "descending",
      ...(at === undefined ? {} : { maxEntryId: bound(at.id - 1) }),
    });
    const page = records.slice(0, limit).reverse();
    if (page.length === 0) return { data: [] };
    const older = records[limit];
    const published = yield* reads.publish(page);
    const data = withinBudget(published, "newest");
    const newer =
      at === undefined
        ? undefined
        : yield* reads
            .published(conversation, { order: "ascending", minEntryId: bound(at.id) })
            .pipe(Stream.take(1), Stream.runHead);
    return {
      data,
      ...(older !== undefined || data.length < published.length ? { prev: (data[0] as Entry).id } : {}),
      ...(newer !== undefined && newer._tag === "Some" ? { next: (data.at(-1) as Entry).id } : {}),
    };
  });
}

/** A page stops at the byte budget (§7), keeping at least one entry: the end nearest its cursor. */
function withinBudget(entries: Entry[], keep: "oldest" | "newest"): Entry[] {
  const ordered = keep === "oldest" ? entries : [...entries].reverse();
  const kept: Entry[] = [];
  let bytes = 0;
  for (const entry of ordered) {
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (kept.length > 0 && bytes + size > LIMITS.pageBytes) break;
    kept.push(entry);
    bytes += size;
  }
  return keep === "oldest" ? kept : kept.reverse();
}
