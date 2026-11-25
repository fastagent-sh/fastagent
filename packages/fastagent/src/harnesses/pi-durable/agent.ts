/**
 * The Agent API over pi-durable: a Harness opened on the instance's storage, and the operations read
 * from and submitted to it. Admission (a key's lookup, the limits and the submission) is one step per process, since
 * one process owns a storage.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  AgentDoc,
  type Conversation,
  type ConversationId,
  DEFAULT_RETRY_POLICY,
  Harness,
  type HarnessInspection,
  type HarnessOptions,
  type HarnessSettings,
  InboxDoc,
  LiveDoc,
  type ModelRef,
  type RegistryReader,
  SessionFailed,
  type Storage,
  type ToolRegistration,
  configure,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  type Agent,
  AgentError,
  type AgentInfo,
  CompactOptions,
  type ContextUsage,
  CreateSessionOptions,
  type Entry,
  EntriesOptions,
  LIMITS,
  ListOptions,
  type Page,
  type Session,
  SessionChanges,
  agentError,
} from "@fastagent-sh/client/agent-api";
import { type WorkTracker, createWorkTracker } from "../../busy.ts";
import type { Unfinished } from "../assembly.ts";
import { type PromiseFailure, fromPromise, originalError } from "../../promise-bridge.ts";
import { log } from "../../log.ts";
import type { Defaults } from "./defaults.ts";
import { imageAt, isPublished, parseImageRef } from "./entries.ts";
import { sessionEvents } from "./events.ts";
import { registerPiSessionIdResolver } from "../tool.ts";
import { type Ids, sessionIdOf as piSessionIdOf, storageIds } from "./ids.ts";
import { Released, countUntilSettled, createPiDurableMessages, decodeInput, released } from "./message-api.ts";
import { SessionMetaDoc, isInput, queuedInputs, usageOfState } from "./messages.ts";
import { durableReads, readEntryPage } from "./reads.ts";
import { releaseWaitingQueues } from "./release.ts";
import { type Sessions, latestContextTokens, trackSessions } from "./sessions.ts";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";

import type { AgentCommand } from "../text.ts";

export interface DurableAgentOptions {
  storage: Storage;
  models: Models;
  registry: RegistryReader;
  settings?: HarnessSettings;
  env?: HarnessOptions["env"];
  /** The instance's name: what `info().name` reports. */
  name: string;
  /** `info().agent`: the program's name (default: the instance's) and description. */
  agent?: { name?: string; description?: string };
  /** `info().starters`: the example first messages in effect. */
  starters?: readonly string[];
  /** Read for every `info()` and send, so a command the definition gains is offered without a restart. */
  commands?: () => readonly AgentCommand[];
  /** What a conversation answers with when its own settings name none (defaults.ts). */
  model?: ModelRef;
  /** The configured default model this agent lacks (`info().unusableDefault`): no `model` then. */
  unusableDefault?: NonNullable<AgentInfo["unusableDefault"]>;
  thinkingLevel?: ModelThinkingLevel;
  /** What becomes of the messages an earlier process accepted and did not end ({@link Unfinished}). */
  unfinished?: Unfinished;
  /** Where the runs' spans go (pi-durable's, and pi-ai's within them). */
  telemetry?: TelemetryContext;
  /** The longest message the storage takes, in bytes of its stored content: a longer one is refused `too_large`. */
  maxMessageBytes?: number;
  /** Per-instance tracker counting unsettled submissions for `busy()`. */
  work?: WorkTracker;
}

export interface DurableAgent extends Agent {
  /** pi-durable's own API, for operating the agent. */
  readonly harness: Harness;
  /** Whether any message submission is currently unsettled on this instance. */
  busy(): boolean;
  /** The conversation a session id names, to operate it through `harness`. */
  conversation(sessionId: string): Promise<Conversation | undefined>;
  close(): Promise<void>;
}

const OWNERLESS = { ownership: { kind: "ownerless" } } as const;

export async function openDurableAgent(options: DurableAgentOptions): Promise<DurableAgent> {
  registerPiSessionIdResolver((api, ctx) =>
    piSessionIdOf(api as Parameters<typeof piSessionIdOf>[0], ctx as Parameters<typeof piSessionIdOf>[1]),
  );
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry: options.registry,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
      onReport: (report) => log.warn(`[fastagent] pi-durable reported ${report.kind}: ${String(report.error)}`),
    },
    context,
  );
  const work = options.work ?? createWorkTracker();
  const lifetime = Scope.makeUnsafe();
  try {
    const ids = await storageIds(harness, context);
    const sessions = await Effect.runPromise(Scope.provide(trackSessions(harness, options.storage, context), lifetime));
    // Before `resume()`, which runs an earlier process's work.
    const inspection = await harness.inspect(context);
    const unsettled = inspection.submissions.filter(isInput);
    const unfinished = options.unfinished ?? "resume";
    if (unsettled.length > 0 && unfinished !== "resume") {
      const where = [...new Set(unsettled.map((record) => record.conversationId))]
        .filter((id) => sessions.has(id))
        .map((id) => ids.encode(id));
      const said = `${unsettled.length} message(s) an earlier process accepted and stopped before they ended (sessions: ${where.join(", ")})`;
      throw new Error(
        `the storage holds ${said}, which this process would not finish: serve the agent until they end, then try again`,
      );
    } else {
      await warnRemovedWork(harness, inspection, options.registry, ids, sessions, context);
      // What an earlier process accepted and did not settle runs on in this one: it is this process's work now.
      for (const record of unsettled) {
        const submission = await harness.submission(record.id, context);
        if (submission !== undefined) countUntilSettled(submission, work);
      }
    }
    harness.resume();
    await Effect.runPromise(Scope.provide(releaseWaitingQueues(harness, context), lifetime));
    return durableAgent(harness, ids, sessions, lifetime, work, options);
  } catch (error) {
    await Effect.runPromise(Scope.close(lifetime, Exit.void));
    await harness.close(context);
    throw error;
  }
}

/**
 * Warn on startup when resumed in-flight work references a tool or task definition the current version no longer has.
 * Reads only conversations with unsettled submissions or live tasks, so idle opens pay nothing.
 */
async function warnRemovedWork(
  harness: Harness,
  inspection: HarnessInspection,
  registry: RegistryReader,
  ids: Ids,
  sessions: Sessions,
  context: Context,
): Promise<void> {
  const label = (conversationId: ConversationId) =>
    sessions.has(conversationId) ? ids.encode(conversationId) : `#${conversationId}`;

  for (const { record, state } of inspection.tasks) {
    if (state.kind !== "blocked") continue;
    log.warn(
      `[fastagent] session ${label(record.conversationId)}: in-flight task ${record.kind} (#${record.id}) is blocked (${state.reason})`,
    );
  }

  const activeConversations = new Set<ConversationId>();
  for (const record of inspection.submissions) if (isInput(record)) activeConversations.add(record.conversationId);
  for (const { record } of inspection.tasks) activeConversations.add(record.conversationId);
  if (activeConversations.size === 0) return;

  const registered = new Set(
    registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool.name),
  );
  for (const conversationId of activeConversations) {
    const [agentDoc, liveDoc] = await Promise.all([
      harness.snapshot(AgentDoc, conversationId, context),
      harness.snapshot(LiveDoc, conversationId, context),
    ]);
    const missing = new Set<string>();
    if (Array.isArray(agentDoc?.tools)) {
      for (const name of agentDoc.tools) if (!registered.has(name)) missing.add(name);
    }
    for (const slot of liveDoc?.tools ?? []) {
      if (slot.status !== "done" && !slot.unoffered && !registered.has(slot.name)) missing.add(slot.name);
    }
    for (const slot of liveDoc?.nestedTools ?? []) {
      if (slot.status !== "done" && !registered.has(slot.name)) missing.add(slot.name);
    }
    if (missing.size > 0) {
      log.warn(
        `[fastagent] session ${label(conversationId)}: resuming in-flight work after tool(s) were removed: ${[...missing].sort().join(", ")}`,
      );
    }
  }
}

function durableAgent(
  harness: Harness,
  ids: Ids,
  sessions: Sessions,
  lifetime: Scope.Closeable,
  work: WorkTracker,
  options: DurableAgentOptions,
): DurableAgent {
  const context = BACKGROUND_CONTEXT;
  const contextUsageOf = (
    conversationId: ConversationId,
    agentDoc: { readonly model?: ModelRef } | undefined,
  ): ContextUsage | undefined => {
    const tokens = sessions.contextTokens(conversationId);
    if (tokens === undefined) return undefined;
    const effective = agentDoc?.model ?? options.model;
    const window =
      effective === undefined
        ? undefined
        : options.models.getModel(effective.provider, effective.modelId)?.contextWindow;
    return {
      tokens,
      ...(window !== undefined && window > 0 ? { contextWindow: window } : {}),
    };
  };
  const reads = durableReads(harness, ids, sessions, context, contextUsageOf);
  const commands = options.commands ?? (() => []);
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

  /** An operation as the Promise the API promises: what it names, or a rejection with an AgentError. */
  const settle = <A>(program: Effect.Effect<A, AgentError | PromiseFailure | Released>): Promise<A> =>
    Effect.runPromise(
      program.pipe(
        Effect.catchCause((cause) => {
          const error = originalError(cause);
          if (error instanceof Released) return Effect.fail(error.reason);
          return Effect.fail(error instanceof AgentError ? error : failureOf(error));
        }),
      ),
    );

  const conversationOf = Effect.fn("pi-durable.conversationOf")(function* (sessionId: string) {
    const conversation = yield* reads.conversation(sessionId);
    if (conversation === undefined) {
      return yield* agentError("not_found", `No session ${sessionId}`);
    }
    return conversation;
  });

  /** The agent's tools by name: the registry's, read for each use, so a tool the definition gains is offered at once. */
  const toolsByName = (): Map<string, ToolRegistration> => {
    const tools = new Map<string, ToolRegistration>();
    for (const { tool } of options.registry.snapshot().tools()) if (!tools.has(tool.name)) tools.set(tool.name, tool);
    return tools;
  };

  /** What pi-durable stores for `changes`: tools by their registrations, which it stores by name. */
  const changeOf = Effect.fn("pi-durable.changeOf")(function* (changes: SessionChanges) {
    const { model, thinkingLevel, instructions, tools } = changes;
    let registrations: ToolRegistration[] | null | undefined;
    if (tools !== undefined && tools !== null) {
      const known = toolsByName();
      const unknown = tools.filter((name) => !known.has(name));
      if (unknown.length > 0) {
        return yield* agentError("invalid_request", `This agent has no tool named ${unknown.join(", ")}`, {
          tools: unknown,
        });
      }
      registrations = tools.map((name) => known.get(name) as ToolRegistration);
    } else registrations = tools;
    return {
      ...(model === undefined
        ? {}
        : { model: model === null ? null : { provider: model.provider, modelId: model.modelId } }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(registrations === undefined ? {} : { tools: registrations }),
    } satisfies AgentChange;
  });

  const presented = options.agent ?? {};
  const info = (): Promise<AgentInfo> =>
    settle(
      Effect.gen(function* () {
        const available = yield* fromPromise(() => options.models.getAvailable());
        const named = ({ name, description }: { name: string; description?: string }) => ({
          name,
          ...(description ? { description } : {}),
        });
        return {
          name: options.name,
          agent: {
            name: presented.name ?? options.name,
            ...(presented.description === undefined ? {} : { description: presented.description }),
          },
          ...(options.starters === undefined ? {} : { starters: [...options.starters] }),
          commands: commands().map(named),
          tools: [...toolsByName().values()].map(named),
          models: available.map((model) => ({
            provider: model.provider,
            modelId: model.id,
            ...(model.name ? { name: model.name } : {}),
            // pi reads a window a model does not declare (a virtual model's, before its first answer) as 0.
            ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
            thinkingLevels: getSupportedThinkingLevels(model),
          })),
          ...(options.model === undefined
            ? {}
            : { defaultModel: { provider: options.model.provider, modelId: options.model.modelId } }),
          ...(options.unusableDefault === undefined ? {} : { unusableDefault: options.unusableDefault }),
        };
      }),
    );

  const defaults: Defaults = {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
  };

  const create = (createOptions?: CreateSessionOptions): Promise<Session> =>
    settle(
      Effect.gen(function* () {
        const { forkFrom, title, ...settings } = yield* decodeInput(
          CreateSessionOptions,
          createOptions ?? {},
          "sessions.create",
        );
        const now = Date.now();
        const initMeta = async (
          tx: Parameters<NonNullable<Parameters<Harness["createConversation"]>[0]["init"]>>[0],
          id: Parameters<NonNullable<Parameters<Harness["createConversation"]>[0]["init"]>>[1],
        ) => {
          const meta = await tx.doc(SessionMetaDoc, id);
          meta.createdAt = now;
          meta.updatedAt = now;
          if (title !== undefined) meta.title = title;
        };
        const creation = { ...OWNERLESS, agent: yield* changeOf(settings), init: initMeta };
        if (forkFrom === undefined) {
          return yield* reads.session(yield* fromPromise(() => harness.createConversation(creation, context)));
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
            ? yield* fromPromise(async () => {
                // pi-durable forks at an entry; an empty source has only settings to inherit.
                const inherited = await harness.snapshot(AgentDoc, source.id, context);
                return harness.createConversation(
                  {
                    ...creation,
                    init: async (tx, id) => {
                      Object.assign(await tx.doc(AgentDoc, id), inherited);
                      await configure(tx, id, creation.agent);
                      await initMeta(tx, id);
                    },
                  },
                  context,
                );
              })
            : yield* fromPromise(() => source.fork(at.id, creation, context));
        if (at !== undefined) {
          const inheritedTokens =
            forkFrom.entryId === undefined
              ? sessions.contextTokens(source.id)
              : latestContextTokens(
                  (yield* fromPromise(() => fork.entries({ order: "descending" }, 20, undefined, context))).items,
                );
          sessions.setContextTokens(fork.id, inheritedTokens);
        }
        return yield* reads.session(fork);
      }),
    );

  const update = (sessionId: string, changes: SessionChanges): Promise<Session> =>
    settle(
      Effect.gen(function* () {
        const decoded = yield* decodeInput(SessionChanges, changes, "sessions.update");
        if (Object.values(decoded).every((value) => value === undefined)) {
          return yield* agentError(
            "invalid_request",
            "Nothing to update: give a title, a model, a thinking level, instructions or tools",
          );
        }
        const conversation = yield* conversationOf(sessionId);
        const { title, ...agentChanges } = decoded;
        const hasAgentChange = Object.values(agentChanges).some((value) => value !== undefined);
        const change = hasAgentChange ? yield* changeOf(agentChanges) : undefined;
        const updated = yield* fromPromise(() =>
          harness.commit(async (tx) => {
            const meta = await tx.doc(SessionMetaDoc, conversation.id);
            if (meta.deleted) return false;
            if (change !== undefined) await configure(tx, conversation.id, change);
            if (title !== undefined) meta.title = title;
            meta.updatedAt = Date.now();
            return true;
          }, context),
        );
        if (!updated) return yield* agentError("not_found", `No session ${sessionId}`);
        return yield* reads.session(conversation);
      }),
    );

  const remove = (sessionId: string): Promise<void> =>
    settle(
      Effect.gen(function* () {
        const conversation = yield* conversationOf(sessionId);
        const marked = yield* fromPromise(() =>
          harness.commit(async (tx) => {
            const meta = await tx.doc(SessionMetaDoc, conversation.id);
            if (meta.deleted) return false;
            meta.deleted = true;
            meta.updatedAt = Date.now();
            return true;
          }, context),
        );
        if (!marked) return yield* agentError("not_found", `No session ${sessionId}`);
        yield* fromPromise(async () => {
          try {
            await conversation.abort(context);
          } catch (error: unknown) {
            if (!closing) throw error;
          }
        });
      }),
    );

  const list = (listOptions?: ListOptions): Promise<Page<Session>> =>
    settle(
      Effect.gen(function* () {
        const { after, limit = LIMITS.pageDefault } = yield* decodeInput(
          ListOptions,
          listOptions ?? {},
          "sessions.list",
        );
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
        const decoded = yield* decodeInput(EntriesOptions, entriesOptions ?? {}, "sessions.entries");
        if (decoded.after !== undefined && decoded.before !== undefined) {
          return yield* agentError("invalid_request", "A page is after an entry or before one, not both");
        }
        return yield* readEntryPage(reads, yield* conversationOf(sessionId), sessionId, decoded);
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
        contextUsageOf,
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
   *. pi-durable runs commits one at a time in the order they are called, and `abort()` calls its commit at once:
   * so the read before it sees what it stops, and the check after it runs once the stop is in the storage.
   */
  const cancel = (sessionId: string): Promise<{ stopped: string[] }> =>
    settle(
      Effect.gen(function* () {
        const conversation = yield* conversationOf(sessionId);
        let abortFailed: unknown;
        const recorded = yield* fromPromise(() => {
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
        const { instructions } = yield* decodeInput(CompactOptions, compactOptions ?? {}, "sessions.compact");
        const conversation = yield* conversationOf(sessionId);
        yield* fromPromise(() => conversation.compact(instructions, context));
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

  const getSession = (sessionId: string): Promise<Session> =>
    settle(conversationOf(sessionId).pipe(Effect.flatMap(reads.session)));
  const messages = createPiDurableMessages({
    harness,
    ids,
    reads,
    context,
    work,
    models: options.models,
    registry: options.registry,
    defaults,
    unusableDefault: options.unusableDefault,
    maxMessageBytes: options.maxMessageBytes,
    commands,
    conversationOf,
    failureOf,
    settle,
    events: (sessionId, after) => events(sessionId, after === undefined ? {} : { after }),
    entry,
    entries,
  });
  return {
    harness,
    info,
    usage: () => settle(fromPromise(() => harness.usage(context)).pipe(Effect.map((spent) => usageOfState(spent)))),
    sessions: {
      create,
      get: getSession,
      list,
      update,
      delete: remove,
      entries,
      events,
      cancel,
      compact,
      attachment,
    },
    messages,
    busy: () => work.active() > 0,
    conversation: (sessionId) => Effect.runPromise(reads.conversation(sessionId)),
    close: async () => {
      closing = true;
      await Effect.runPromise(Scope.close(lifetime, Exit.void));
      await harness.close(context);
    },
  };
}
