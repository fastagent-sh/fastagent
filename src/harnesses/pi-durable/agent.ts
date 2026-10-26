/**
 * The Agent API (docs/design/agent-api.md) over pi-durable: a Harness opened on the instance's storage, and the ten
 * operations read from and submitted to it. Admission (a key's lookup, the limits and the submission) is one step per
 * process, since one process owns a storage.
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ImageContent, Models, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type Conversation,
  ConversationBusy,
  DEFAULT_RETRY_POLICY,
  SessionFailed,
  type EntryRecord,
  Harness,
  type HarnessOptions,
  type HarnessSettings,
  type ModelRef,
  type RegistryReader,
  type Storage,
  type Submission,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  type AbortResult,
  type Agent,
  type AgentError,
  type AgentInfo,
  AgentRejection,
  type ConfigureResult,
  type ContentPart,
  type CreateSessionOptions,
  type CreateSessionResult,
  type Entry,
  type InvokeRequest,
  type InvokeResult,
  LIMITS,
  type ListOptions,
  type ListResult,
  type ReadOptions,
  type ReadResult,
  type SessionSettings,
  type WaitResult,
  agentError,
  failure,
} from "../../agent-api.ts";
import { beginWork } from "../../channels/busy.ts";
import { type PortFailure, port, portError } from "../../effect-port.ts";
import { log } from "../../log.ts";
import { USER_ENTRY, type UserEntryData, imageAt, parseImageRef } from "./entries.ts";
import { type Defaults, takeDefaults } from "./defaults.ts";
import { type Ids, storageIds } from "./ids.ts";
import { type InputRecord, hasEnded, isInput, queuedInputs, requestIdFor } from "./messages.ts";
import { type Reads, durableReads } from "./reads.ts";
import { releaseWaitingQueues } from "./release.ts";
import { resumeStream } from "./resume.ts";
import { type Sessions, trackSessions } from "./sessions.ts";

/** What a Caller may offer as `/<name>`: a prompt template or a skill, expanded for the model (agent-api.md §3). */
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
  /** Read for every `info()` and invoke, so a command the definition gains is offered without a restart. */
  commands?: () => readonly AgentCommand[];
  /** What a conversation answers with when its own settings name none (defaults.ts). */
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  inFlightPerProcess?: number;
}

export interface DurableAgent extends Agent {
  /** pi-durable's own API, for operating the agent (agent-api.md §11). */
  readonly harness: Harness;
  /** The conversation a session id names, to operate it through `harness`. */
  conversation(sessionId: string): Promise<Conversation | undefined>;
  close(): Promise<void>;
}

const INPUTS = ["text", "image"];
const OWNERLESS = { ownership: { kind: "ownerless" } } as const;
const COMMAND = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

export async function openDurableAgent(options: DurableAgentOptions): Promise<DurableAgent> {
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry: options.registry,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.env === undefined ? {} : { env: options.env }),
      onReport: (error) => log.warn(`[fastagent] pi-durable reported: ${String(error)}`),
    },
    context,
  );
  const lifetime = Scope.makeUnsafe();
  try {
    const ids = await storageIds(harness, context);
    const sessions = await Effect.runPromise(Scope.provide(trackSessions(harness, options.storage, context), lifetime));
    // What an earlier process accepted and did not settle runs on in this one: it is this process's work now.
    for (const record of (await harness.inspect(context)).submissions) {
      if (!isInput(record)) continue;
      const submission = await harness.submission(record.id, context);
      if (submission !== undefined) countUntilSettled(submission);
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
  /** An operation's Effect as the Promise the API promises: a failure becomes the operation's failure value. */
  const resolve = <A>(program: Effect.Effect<A, PortFailure>, failed: (error: unknown) => A): Promise<A> =>
    Effect.runPromise(program.pipe(Effect.catchCause((cause) => Effect.sync(() => failed(portError(cause))))));
  /** `getMessage` and `attachment` have no failure value: they reject (agent-api.md §2). */
  const settleOrReject = <A>(program: Effect.Effect<A, PortFailure>): Promise<A> =>
    Effect.runPromise(
      program.pipe(Effect.catchCause((cause) => Effect.fail(new AgentRejection(failureOf(portError(cause)))))),
    );
  const failed = (error: unknown) => ({ ok: false as const, error: failureOf(error) });
  const info = (): AgentInfo => ({
    protocolVersion: "1.0",
    name: options.name,
    ...(options.description === undefined ? {} : { description: options.description }),
    inputs: INPUTS,
    commands: commands().map(({ name, description }) => ({
      name,
      ...(description === undefined ? {} : { description }),
    })),
  });

  const wait = (id: SubmissionId, signal: AbortSignal | undefined): Promise<WaitResult> =>
    resolve<WaitResult>(
      Effect.gen(function* () {
        const waiting = signal === undefined ? context : withAbortSignal(signal, context);
        const handle = yield* port(() => harness.submission(id, waiting));
        if (handle === undefined) throw new Error(`submission ${id} is not in the storage it was accepted into`);
        const record = yield* port(() => handle.wait(waiting));
        if (!isInput(record) || !hasEnded(record)) throw new Error(`submission ${id} settled as a write`);
        return { ok: true, message: yield* reads.done(record) };
      }),
      (error) => ({
        ok: false,
        unfinished: { reason: signal?.aborted ? "The wait was aborted" : failureOf(error).message },
      }),
    );

  const unknownReceipt = (conversation: Conversation, messageId: number | undefined, error: unknown): InvokeResult => ({
    ok: false,
    unknown: {
      reason: `${messageId === undefined ? "The submission's acceptance could not be confirmed" : "The message was recorded, but its receipt could not be read"}: ${failureOf(error).message}`,
      sessionId: ids.encode(conversation.id),
      ...(messageId === undefined ? {} : { messageId: ids.encode(messageId) }),
    },
  });

  const receipt = (conversation: Conversation, record: InputRecord, duplicate: boolean) =>
    reads.status(record).pipe(
      Effect.map(
        (message): InvokeResult => ({
          ok: true,
          sessionId: ids.encode(conversation.id),
          message,
          duplicate,
          wait: (waitOptions) => wait(record.id, waitOptions?.signal),
        }),
      ),
      Effect.catchCause((cause) => Effect.sync(() => unknownReceipt(conversation, record.id, portError(cause)))),
    );

  const inFlight = port(() => harness.inspect(context)).pipe(
    Effect.map(({ submissions }) => submissions.filter((record) => record.type === "input").length),
  );

  const defaults: Defaults = {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
  };

  const available = (model: ModelRef) => options.models.getModel(model.provider, model.modelId) !== undefined;
  /** A message no model could answer is refused, recording nothing, rather than accepted only to fail. */
  const noModel = (model: ModelRef | undefined) =>
    failure(
      "missing_model",
      model === undefined
        ? "Neither this session nor the agent names a model"
        : `This session answers with ${model.provider}/${model.modelId}, which is not among this agent's models`,
      model === undefined ? undefined : { model: `${model.provider}/${model.modelId}` },
    );

  const admit = (request: InvokeRequest): Effect.Effect<InvokeResult, PortFailure> =>
    Effect.gen(function* () {
      const requestId = requestIdFor(request.idempotencyKey);
      // Before anything is written: reading or expanding a command reads the definition's files, and may throw.
      const { content, sent } = expandCommand(request.content, commands());
      let conversation: Conversation | undefined;
      if (request.sessionId !== undefined) {
        conversation = yield* reads.conversation(request.sessionId);
        if (conversation === undefined) return failure("not_found", `No session ${request.sessionId}`);
        if (request.idempotencyKey !== undefined) {
          const seen = yield* reads.submissionByKey(conversation, requestId);
          if (seen !== undefined) return yield* receipt(conversation, seen, true);
        }
      }
      if ((yield* inFlight) >= inFlightLimit) {
        return failure("busy", `This agent already holds ${inFlightLimit} messages`, { reason: "capacity" });
      }
      if (conversation === undefined) {
        if (defaults.model === undefined || !available(defaults.model)) return noModel(defaults.model);
        conversation = yield* port(() => harness.createConversation(OWNERLESS, context));
      } else if (request.whenBusy !== "reject") {
        const inbox = yield* reads.inbox(conversation);
        if (queuedInputs(inbox).length >= LIMITS.queuedPerSession) {
          return failure("busy", `The session already has ${LIMITS.queuedPerSession} queued messages`, {
            reason: "queue_full",
          });
        }
      }
      const target = conversation;
      const settings = yield* port(() =>
        target.commit((tx) => takeDefaults(tx, target.id, defaults, available), context),
      );
      if (!settings.ok) return noModel(settings.model);
      const data: UserEntryData = { requestId, ...(sent === undefined ? {} : { sent }) };
      let messageId: SubmissionId | undefined;
      return yield* Effect.gen(function* () {
        const submission = yield* port(() =>
          target.submit(
            {
              type: "input",
              content,
              requestId,
              whenBusy: request.whenBusy === "steer" ? "steer" : request.whenBusy === "reject" ? "reject" : "followUp",
              entry: { kind: USER_ENTRY, data },
            },
            context,
          ),
        );
        messageId = submission.id;
        // Counted once its receipt is read, whether or not that read succeeds: the wait must not be what reads the
        // storage first, or a failing read would fail it instead of answering this call.
        const record = yield* port(() => submission.status(context)).pipe(
          Effect.ensuring(Effect.sync(() => countUntilSettled(submission))),
        );
        if (!isInput(record)) throw new Error(`submission ${record.id} was admitted as a write`);
        return yield* receipt(target, record, false);
      }).pipe(
        // Once submission starts, only pi-durable's explicit refusal proves nothing was recorded.
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = portError(cause);
            return messageId === undefined && error instanceof ConversationBusy
              ? failure("busy", "The session is answering another message", { reason: "running" })
              : unknownReceipt(target, messageId, error);
          }),
        ),
      );
    });

  const invoke = (request: InvokeRequest): Promise<InvokeResult> => {
    const refused = invalidInvoke(request);
    if (refused !== undefined) return Promise.resolve({ ok: false, error: refused });
    return resolve<InvokeResult>(Semaphore.withPermits(admission, 1)(admit(request)), failed);
  };

  const getMessage: Agent["getMessage"] = (sessionId, key) =>
    settleOrReject(
      Effect.gen(function* () {
        const conversation = yield* reads.conversation(sessionId);
        if (conversation === undefined) return undefined;
        const record =
          "messageId" in key
            ? yield* reads.submission(key.messageId)
            : yield* reads.submissionByKey(conversation, requestIdFor(key.idempotencyKey));
        if (record === undefined || record.conversationId !== conversation.id) return undefined;
        return yield* reads.status(record);
      }),
    );

  const createSession = (createOptions?: CreateSessionOptions): Promise<CreateSessionResult> =>
    resolve<CreateSessionResult>(
      Effect.gen(function* () {
        const { from, model, thinkingLevel } = createOptions ?? {};
        const agent = {
          ...(model === undefined ? {} : { model }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        };
        const creation = { ...OWNERLESS, agent };
        if (from === undefined) {
          const created = yield* port(() => harness.createConversation(creation, context));
          return { ok: true, sessionId: ids.encode(created.id) };
        }
        if (from.context === "recent") {
          return failure("invalid_request", 'A fork with context "recent" is not implemented yet');
        }
        const source = yield* reads.conversation(from.sessionId);
        if (source === undefined) return failure("not_found", `No session ${from.sessionId}`);
        const at =
          from.entryId === undefined
            ? yield* reads.history(source, { order: "descending" }).pipe(
                Stream.runHead,
                Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
              )
            : yield* reads.visibleEntry(source, from.entryId);
        if (at === undefined && from.entryId !== undefined) {
          return failure("not_found", `No entry ${from.entryId} in session ${from.sessionId}`);
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
                      Object.assign(await tx.doc(AgentDoc, id), inherited, agent);
                    },
                  },
                  context,
                );
              })
            : yield* port(() => source.fork(at.id, creation, context));
        return { ok: true, sessionId: ids.encode(fork.id) };
      }),
      failed,
    );

  /** pi-durable's `configure()`, its two fields a Caller sets: stored as given, used from the next model request. */
  const configure = (sessionId: string, settings: SessionSettings): Promise<ConfigureResult> => {
    const { model, thinkingLevel } = settings;
    if (model === undefined && thinkingLevel === undefined) {
      return Promise.resolve(
        failure("invalid_request", "Nothing to configure: give a model, a thinking level or both"),
      );
    }
    return resolve<ConfigureResult>(
      Effect.gen(function* () {
        const conversation = yield* reads.conversation(sessionId);
        if (conversation === undefined) return failure("not_found", `No session ${sessionId}`);
        const change = {
          ...(model === undefined ? {} : { model: { provider: model.provider, modelId: model.modelId } }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        };
        yield* port(() => conversation.configure(change, context));
        return { ok: true };
      }),
      failed,
    );
  };

  const read = (sessionId: string, readOptions: ReadOptions = {}): Promise<ReadResult> => {
    const refused = invalidRead(readOptions);
    if (refused !== undefined) return Promise.resolve({ ok: false, error: refused });
    return resolve<ReadResult>(readPage(reads, sessionId, readOptions), failed);
  };

  /** The conversation's newest message id, ended ones included; 0 before its first. */
  const newestSubmission = (conversation: Conversation) =>
    port(() =>
      options.storage.scanSubmissions({ conversationId: conversation.id, order: "descending" }, 1, undefined, context),
    ).pipe(Effect.map((page) => page.items[0]?.id ?? 0));

  /** The conversation's messages newer than `boundary` that an abort ended. */
  const abortedSince = (conversation: Conversation, boundary: number): Effect.Effect<InputRecord[], PortFailure> =>
    Effect.gen(function* () {
      const found: InputRecord[] = [];
      let cursor: Parameters<Storage["scanSubmissions"]>[2];
      do {
        const page = yield* port(() =>
          options.storage.scanSubmissions(
            { conversationId: conversation.id, status: "unanswered", order: "descending" },
            LIMITS.queuedPerSession,
            cursor,
            context,
          ),
        );
        for (const record of page.items) {
          if (record.id <= boundary) return found;
          if (isInput(record) && record.reason === "aborted") found.push(record);
        }
        cursor = page.next;
      } while (cursor !== undefined);
      return found;
    });

  const abort = (sessionId: string, abortOptions?: { signal?: AbortSignal }): Promise<AbortResult> =>
    resolve<AbortResult>(
      Effect.gen(function* () {
        const conversation = yield* reads.conversation(sessionId);
        if (conversation === undefined) return failure("not_found", `No session ${sessionId}`);
        // Read before the state: a message admitted between this read and the stop is newer than it, and one admitted
        // before it is in the state unless it has ended.
        const boundary = yield* newestSubmission(conversation);
        const before = yield* reads.state(conversation);
        const signal = abortOptions?.signal;
        const stopping = signal === undefined ? context : withAbortSignal(signal, context);
        const stopped = yield* port(() => conversation.abort(stopping)).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) =>
            Effect.succeed(signal?.aborted ? "The abort was aborted" : failureOf(portError(cause)).message),
          ),
        );
        if (stopped !== undefined) return { ok: false, unknown: { reason: stopped } };
        const ended = new Map<number, InputRecord>();
        for (const messageId of [...before.taken, ...before.queued]) {
          const record = yield* reads.submission(messageId);
          if (record?.status === "unanswered" && record.reason === "aborted") ended.set(record.id, record);
        }
        // Not told apart: a message invoked after this stop that a later abort ended before this read.
        for (const record of yield* abortedSince(conversation, boundary)) ended.set(record.id, record);
        const records = [...ended.values()].sort((a, b) => a.id - b.id);
        const idsOf = (taken: boolean) =>
          records.filter((record) => (record.entry !== undefined) === taken).map((record) => ids.encode(record.id));
        return { ok: true, stopped: { taken: idsOf(true), queued: idsOf(false) } };
      }),
      failed,
    );

  const attachment: Agent["attachment"] = (sessionId, ref) =>
    settleOrReject(
      Effect.gen(function* () {
        const parsed = parseImageRef(ref);
        if (parsed === undefined) return undefined;
        const conversation = yield* reads.conversation(sessionId);
        if (conversation === undefined) return undefined;
        const entry = yield* reads.visibleEntry(conversation, parsed.entryId);
        const image = entry === undefined ? undefined : imageAt(entry, parsed.index);
        return image === undefined ? undefined : { mimeType: image.mimeType, data: image.data };
      }),
    );

  /** Most recently active first; the cursor is the activity of the last session a page listed. */
  const listSessions = async (listOptions: ListOptions = {}): Promise<ListResult> => {
    const { before, limit = LIMITS.readDefault } = listOptions;
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.readMax) {
      return failure("invalid_request", `limit is an integer from 1 to ${LIMITS.readMax}`);
    }
    const after = before === undefined ? undefined : ids.decodeCursor(before);
    if (before !== undefined && after === undefined) {
      return failure("invalid_request", `${JSON.stringify(before)} is not a cursor of this agent's`);
    }
    const ordered = sessions.byActivity();
    const rest = after === undefined ? ordered : ordered.filter(({ activity }) => activity < after);
    const page = rest.slice(0, limit);
    const last = page.at(-1);
    return {
      ok: true,
      sessions: page.map(({ conversationId }) => ({ sessionId: ids.encode(conversationId) })),
      ...(rest.length > limit && last !== undefined ? { next: ids.encodeCursor(last.activity) } : {}),
    };
  };

  return {
    harness,
    info,
    invoke,
    getMessage,
    createSession,
    configure,
    read,
    resume: (sessionId, resumeOptions) =>
      Stream.toAsyncIterable(
        resumeStream(
          {
            harness,
            reads,
            ids,
            context,
            failureOf,
            maxRetries: options.settings?.retry?.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
          },
          sessionId,
          resumeOptions?.replayFrom,
        ),
      ),
    abort,
    attachment,
    listSessions,
    conversation: (sessionId) => Effect.runPromise(reads.conversation(sessionId)),
    close: async () => {
      closing = true;
      await Effect.runPromise(Scope.close(lifetime, Exit.void));
      await harness.close(context);
    },
  };
}

function invalidInvoke(request: InvokeRequest): AgentError | undefined {
  const { sessionId, idempotencyKey, content } = request;
  if (idempotencyKey !== undefined) {
    if (sessionId === undefined) return agentError("invalid_request", "An idempotencyKey requires a sessionId");
    if (idempotencyKey.length < 1 || idempotencyKey.length > LIMITS.idempotencyKeyMax) {
      return agentError("invalid_request", `An idempotencyKey has 1 to ${LIMITS.idempotencyKeyMax} characters`);
    }
  }
  if (content.length === 0) return agentError("invalid_request", "A message has at least one content part");
  const outside = content.find((part) => !INPUTS.includes(part.type));
  if (outside !== undefined) {
    return agentError("invalid_request", `This agent does not take content of type ${JSON.stringify(outside.type)}`);
  }
  if (content.some((part) => part.type === "image" && !("data" in part))) {
    return agentError("invalid_request", "An image in a message carries its data, not a ref");
  }
  return undefined;
}

function invalidRead({ after, before, limit }: ReadOptions): AgentError | undefined {
  if (after !== undefined && before !== undefined) {
    return agentError("invalid_request", "A read pages after an entry or before one, not both");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0 || limit > LIMITS.readMax)) {
    return agentError("invalid_request", `limit is an integer from 0 to ${LIMITS.readMax}`);
  }
  return undefined;
}

/** The content the model sees, and the first text as sent when it was a command the agent expanded. */
function expandCommand(
  content: ContentPart[],
  commands: readonly AgentCommand[],
): { content: (TextContent | ImageContent)[]; sent?: string } {
  const parts = content.map((part): TextContent | ImageContent =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", mimeType: part.mimeType, data: (part as { data: string }).data },
  );
  const first = parts[0];
  const match = first?.type === "text" ? COMMAND.exec(first.text) : null;
  const command = match === null ? undefined : commands.find(({ name }) => name === match[1]);
  if (first?.type !== "text" || match === null || command === undefined) return { content: parts };
  return { content: [{ type: "text", text: command.expand(match[2] ?? "") }, ...parts.slice(1)], sent: first.text };
}

/** One page of a session's published entries (agent-api.md §5): after a cursor, before one, or the newest. */
function readPage(
  reads: Reads,
  sessionId: string,
  { after, before, limit = LIMITS.readDefault }: ReadOptions,
): Effect.Effect<ReadResult, PortFailure> {
  return Effect.gen(function* () {
    const conversation = yield* reads.conversation(sessionId);
    if (conversation === undefined) return failure("not_found", `No session ${sessionId}`);
    const cursor = after ?? before;
    const at = cursor === undefined ? undefined : yield* reads.visibleEntry(conversation, cursor);
    if (cursor !== undefined && at === undefined) {
      return failure("not_found", `No entry ${cursor} in session ${sessionId}`);
    }
    const state = yield* reads.state(conversation);
    if (limit === 0) return { ok: true, state, entries: [] };
    const bound = (id: number) => id as EntryRecord["id"];
    const take = (query: Parameters<Reads["published"]>[1]) =>
      reads.published(conversation, query).pipe(Stream.take(limit + 1), Stream.runCollect);

    if (after !== undefined && at !== undefined) {
      const records = yield* take({ order: "ascending", minEntryId: bound(at.id + 1) });
      const page = records.slice(0, limit);
      const first = page[0];
      if (first === undefined) return { ok: true, state, entries: [] };
      const parent = yield* reads.newestPublished(conversation, first.id - 1);
      const entries = withinBudget(yield* reads.publish(page, parent), "oldest");
      const last = entries.at(-1) as Entry;
      return {
        ok: true,
        state,
        entries,
        ...(parent === undefined ? {} : { prev: (entries[0] as Entry).id }),
        ...(records.length > limit || entries.length < page.length ? { next: last.id } : {}),
      };
    }

    const records = yield* take({
      order: "descending",
      ...(at === undefined ? {} : { maxEntryId: bound(at.id - 1) }),
    });
    const page = records.slice(0, limit).reverse();
    if (page.length === 0) return { ok: true, state, entries: [] };
    const older = records[limit];
    const published = yield* reads.publish(page, older?.id);
    const entries = withinBudget(published, "newest");
    const newer =
      at === undefined
        ? undefined
        : yield* reads
            .published(conversation, { order: "ascending", minEntryId: bound(at.id) })
            .pipe(Stream.take(1), Stream.runHead);
    const first = entries[0] as Entry;
    const last = entries.at(-1) as Entry;
    return {
      ok: true,
      state,
      entries,
      ...(older !== undefined || entries.length < published.length ? { prev: first.id } : {}),
      ...(newer !== undefined && newer._tag === "Some" ? { next: last.id } : {}),
    };
  });
}

/** A page stops at the byte budget (agent-api.md §7.2), keeping at least one entry: the end nearest its cursor. */
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
