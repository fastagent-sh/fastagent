/**
 * The Agent API (docs/design/agent-api.md) over pi-durable: a Harness opened on the instance's storage, and the eight
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
  type ContentPart,
  type CreateSessionOptions,
  type CreateSessionResult,
  type Entry,
  type InvokeRequest,
  type InvokeResult,
  LIMITS,
  type ReadOptions,
  type ReadResult,
  type WaitResult,
  agentError,
  failure,
} from "../../agent-api.ts";
import { type PortFailure, port, portError } from "../../effect-port.ts";
import { log } from "../../log.ts";
import { USER_ENTRY, type UserEntryData, imageAt, parseImageRef } from "./entries.ts";
import { type Defaults, takeDefaults } from "./defaults.ts";
import { type Ids, storageIds } from "./ids.ts";
import { type InputRecord, hasEnded, isInput, queuedInputs, requestIdFor } from "./messages.ts";
import { type Reads, durableReads } from "./reads.ts";
import { releaseWaitingQueues } from "./release.ts";
import { resumeStream } from "./resume.ts";

/** What a Caller may offer as `/<name>`: a prompt template or a skill, expanded for the model (agent-api.md §3). */
interface AgentCommand {
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
  commands?: readonly AgentCommand[];
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
    harness.resume();
    await Effect.runPromise(Scope.provide(releaseWaitingQueues(harness, context), lifetime));
    return durableAgent(harness, ids, lifetime, options);
  } catch (error) {
    await Effect.runPromise(Scope.close(lifetime, Exit.void));
    await harness.close(context);
    throw error;
  }
}

function durableAgent(
  harness: Harness,
  ids: Ids,
  lifetime: Scope.Closeable,
  options: DurableAgentOptions,
): DurableAgent {
  const context = BACKGROUND_CONTEXT;
  const reads = durableReads(harness, ids, context);
  const admission = Semaphore.makeUnsafe(1);
  const commands = options.commands ?? [];
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
  const info: AgentInfo = {
    protocolVersion: "1.0",
    name: options.name,
    ...(options.description === undefined ? {} : { description: options.description }),
    inputs: INPUTS,
    commands: commands.map(({ name, description }) => ({
      name,
      ...(description === undefined ? {} : { description }),
    })),
  };

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
      const { content, sent } = expandCommand(request.content, commands);
      const data: UserEntryData = { requestId, ...(sent === undefined ? {} : { sent }) };
      const submitted = yield* port(() =>
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
      ).pipe(
        Effect.map((submission) => ({ submission })),
        Effect.catchIf(
          (error) => error.cause instanceof ConversationBusy,
          () => Effect.succeed({ busy: true } as const),
        ),
      );
      if ("busy" in submitted) {
        return failure("busy", "The session is answering another message", { reason: "running" });
      }
      const record = yield* port(() => submitted.submission.status(context));
      if (!isInput(record)) throw new Error(`submission ${record.id} was admitted as a write`);
      return yield* receipt(conversation, record, false);
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

  const read = (sessionId: string, readOptions: ReadOptions = {}): Promise<ReadResult> => {
    const refused = invalidRead(readOptions);
    if (refused !== undefined) return Promise.resolve({ ok: false, error: refused });
    return resolve<ReadResult>(readPage(reads, sessionId, readOptions), failed);
  };

  const abort = (sessionId: string, abortOptions?: { signal?: AbortSignal }): Promise<AbortResult> =>
    resolve<AbortResult>(
      Effect.gen(function* () {
        const conversation = yield* reads.conversation(sessionId);
        if (conversation === undefined) return failure("not_found", `No session ${sessionId}`);
        // What it stops is read before the stop: a message admitted between the two is withdrawn but not reported.
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
        const canceled = (messageIds: string[]) =>
          Effect.filter(messageIds, (messageId) =>
            reads
              .submission(messageId)
              .pipe(Effect.map((record) => record?.status === "unanswered" && record.reason === "aborted")),
          );
        return { ok: true, stopped: { taken: yield* canceled(before.taken), queued: yield* canceled(before.queued) } };
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

  return {
    harness,
    info: () => info,
    invoke,
    getMessage,
    createSession,
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
