/**
 * pi-durable as a `HarnessPort` (docs/design/agent-service.md §9.1): a durable harness, implementing the port directly.
 * Its submissions are the message records (each settles once, in the commit with the entries it settles with), its
 * inbox is the queue, its runs continue after a restart. What the port adds is the protocol's naming and four facts
 * pi-durable does not keep:
 *
 * - which session id names which conversation, and its name (`fastagent.sessions`);
 * - why a message was canceled (`fastagent.stops`), since pi-durable says only `aborted`;
 * - where the work of a message that did not answer ended (`fastagent.ended`), a write after such a run that also places
 *   the inputs pi-durable leaves waiting behind a run that failed or was aborted;
 * - a message id: the request id, `k:<key>` or `m:<minted>`, so its native dedup by request id is the protocol's.
 */
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  ConversationBusy,
  DEFAULT_RETRY_POLICY,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  InboxDoc,
  LiveDoc,
  type Storage,
  type SubmissionId,
  type SubmissionRecord,
  defineDoc,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { HarnessPort, Page, PortRead } from "../../harness-port.ts";
import { log } from "../../log.ts";
import {
  type AbortResult,
  type AgentCommand,
  type Capabilities,
  type Entry,
  type Json,
  LIMITS,
  type MessageSource,
  type MessageStatus,
  type ModelDescriptor,
  type Outcome,
  type Prompt,
  type Result,
  type SessionEvent,
  type SessionState,
  type Usage,
  agentError,
  failure,
} from "../../protocol.ts";
import { imageIn, parseImageRef } from "../pi/entry-images.ts";
import { messageRecord } from "../pi/log-records.ts";

type SessionIndex = {
  byId: { [sessionId: string]: { conversationId: number; createdAt: number; updatedAt: number; name?: string } };
};

const Sessions = defineDoc<SessionIndex>({
  kind: "fastagent.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ byId: {} }),
});

type StopReason = "cancel" | "abort" | "delete";

const Stops = defineDoc<{ byMessage: { [messageId: string]: { by: StopReason; at: number } } }>({
  kind: "fastagent.stops",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ byMessage: {} }),
});

/** A message's own entry: the input, placed as this kind so it carries its id, key and source. */
const USER = "fastagent.user";
/** Where the work of messages that did not answer ended: `{ messages, lastEntryId, endedAt }`. */
const ENDED = "fastagent.ended";

type UserData = { messageId: string; idempotencyKey?: string; source: MessageSource };
type EndedData = { messages: string[]; lastEntryId: string | null; endedAt: number };

const PREVIEW_CHARS = 80;

export interface PiDurablePortOptions {
  harness: Harness;
  /** The storage the harness was opened on: committed reads that need no commit of their own. */
  storage: Storage;
  context: Context;
  /** What a new conversation runs on. */
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  /** Each model a session may be set to, as `provider/modelId`. */
  models: () => Promise<ModelDescriptor[]>;
  commands?: () => Promise<AgentCommand[]>;
  inFlightPerProcess?: number;
  /** The harness's `settings.retry.maxRetries`, when set: what `retry_scheduled` reports as its attempts. */
  maxRetries?: number;
}

const idOf = (id: number | string): string => String(id);

const firstMessage = (entry: EntryRecord): Message | undefined => entry.model?.[0];

const timestampOf = (entry: EntryRecord | undefined): number | undefined =>
  (entry && (firstMessage(entry) as { timestamp?: number } | undefined)?.timestamp) ?? undefined;

/** An entry as the protocol publishes it, or undefined for the harness's and the port's own bookkeeping. */
function published(entry: EntryRecord, own = true): Omit<Entry, "parentEntryId"> | undefined {
  const id = idOf(entry.id);
  const message = firstMessage(entry);
  const base = { id, timestamp: timestampOf(entry) ?? 0 };
  if (entry.kind === USER && message) {
    const { kind, data } = messageRecord(id, message as never);
    return own
      ? { ...base, kind, data: { ...(data as Record<string, Json>), ...(entry.data as UserData) } }
      : { ...base, kind, data };
  }
  if (entry.kind === "pi.user" || entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") {
    return message ? { ...base, ...messageRecord(id, message as never) } : undefined;
  }
  if (entry.kind === "pi.compaction") {
    const data = entry.data as { summary?: string; firstKeptEntryId?: number } | undefined;
    return {
      ...base,
      kind: "compaction",
      data: { summary: data?.summary ?? "", firstKeptEntryId: idOf(entry.head ?? data?.firstKeptEntryId ?? "") },
    };
  }
  return undefined;
}

function sumUsage(messages: AssistantMessage[]): Usage | undefined {
  if (messages.length === 0) return undefined;
  const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
  for (const { usage } of messages) {
    total.inputTokens += usage.input;
    total.outputTokens += usage.output;
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + usage.cacheRead;
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + usage.cacheWrite;
    total.cost = (total.cost ?? 0) + usage.cost.total;
  }
  return total;
}

/** What pi-durable's `unanswered` reasons are in the protocol. A cancel the port asked for says which. */
function unansweredOutcome(reason: string, detail: unknown, stop: StopReason | undefined): Outcome {
  if (reason === "aborted") return { status: "canceled", by: stop ?? "abort" };
  const message = typeof detail === "string" && detail !== "" ? detail : reason;
  if (reason === "model_error") return { status: "failed", error: agentError("model_error", message) };
  if (reason === "no_model") return { status: "failed", error: agentError("missing_model", message) };
  return { status: "failed", error: agentError("internal", `${reason}: ${message}`) };
}

type Listener = (event: SessionEvent, after: string | undefined) => void;

/** The port over an open harness, after ending what a previous process left without an end. */
export async function piDurablePort(options: PiDurablePortOptions): Promise<HarnessPort> {
  const { harness, storage, context } = options;
  const capabilities: Capabilities = {
    steer: true,
    fork: true,
    rewind: false,
    compaction: true,
    delete: false,
    updatable: ["name", "model", "thinkingLevel"],
    durableQueue: true,
    durableWork: true,
    toolProgress: false,
    usage: true,
  };
  const listeners = new Map<string, Set<Listener>>();
  /** Every conversation this process serves is followed, listened to or not: its ends are written as they happen. */
  const followed = new Set<number>();
  /** One admission at a time per session: looking a key up and submitting under it are one step (SPEC v1 §3.3). */
  const admissions = new Map<string, Promise<unknown>>();

  const sessionOf = async (sessionId: string) => (await harness.snapshot(Sessions, context))?.byId[sessionId];

  const conversationOf = async (sessionId: string): Promise<Conversation | undefined> => {
    const known = await sessionOf(sessionId);
    return known === undefined ? undefined : harness.conversation(known.conversationId as ConversationId, context);
  };

  /** Every entry of a conversation, oldest first, its forked-from history included. */
  const entriesOf = async (conversation: Conversation): Promise<EntryRecord[]> => {
    const all: EntryRecord[] = [];
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries({ order: "ascending" }, 500, cursor, context);
      all.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return all;
  };

  /** A fork's inherited entries are history, not messages: they name none. */
  const publish = (records: readonly EntryRecord[], own: ConversationId): Entry[] => {
    const entries: Entry[] = [];
    for (const record of records) {
      const entry = published(record, record.conversationId === own);
      if (!entry) continue;
      const parent = entries.at(-1)?.id;
      entries.push(parent === undefined ? entry : { ...entry, parentEntryId: parent });
    }
    return entries;
  };

  const endedRecords = (records: EntryRecord[]): Map<string, EndedData> => {
    const ended = new Map<string, EndedData>();
    for (const record of records) {
      if (record.kind !== ENDED) continue;
      const data = record.data as EndedData;
      for (const messageId of data.messages) ended.set(messageId, data);
    }
    return ended;
  };

  /** A message's status from its submission and the conversation's committed state, read once. */
  const statusOf = async (
    conversation: Conversation,
    record: SubmissionRecord,
    records: EntryRecord[],
  ): Promise<MessageStatus> => {
    const messageId = record.requestId as string;
    const own = record.entry === undefined ? undefined : records.find((r) => r.id === record.entry);
    const data = own?.kind === USER ? (own.data as UserData) : undefined;
    const base = {
      messageId,
      ...(data?.idempotencyKey === undefined ? {} : { idempotencyKey: data.idempotencyKey }),
      ...(data ? { source: data.source } : {}),
    };
    if (record.status === "queued") {
      const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
      const inputs = (inbox?.items ?? []).filter((item) => item.mode !== "write");
      const order = [...inputs.filter((i) => i.mode === "steer"), ...inputs.filter((i) => i.mode === "followUp")];
      return {
        ...base,
        status: "queued",
        position: Math.max(
          0,
          order.findIndex((i) => i.id === record.id),
        ),
      };
    }
    const entryId = record.entry === undefined ? undefined : idOf(record.entry);
    const takenAt = timestampOf(own);
    if (record.status === "placed") {
      return { ...base, status: "taken", entryId: entryId as string, takenAt: takenAt ?? Date.now() };
    }
    if (record.type !== "input") throw new Error(`submission ${record.id} is not an input`);
    const stops = await harness.snapshot(Stops, conversation.id, context);
    if (record.status === "done") {
      const answer = records.find((r) => r.id === record.answer);
      const message = answer && (firstMessage(answer) as AssistantMessage | undefined);
      return {
        ...base,
        status: "done",
        ...(entryId === undefined ? {} : { entryId, ...(takenAt === undefined ? {} : { takenAt }) }),
        lastEntryId: idOf(record.answer),
        endedAt: timestampOf(answer) ?? Date.now(),
        outcome: message?.stopReason === "length" ? { status: "max_tokens" } : { status: "completed" },
        ...(await usageOwner(conversation, record, records)),
        ...(message ? { answer: { entryId: idOf(record.answer), text: textOf(message) } } : {}),
      };
    }
    const stop = stops?.byMessage[messageId];
    const ended = endedRecords(records).get(messageId);
    return {
      ...base,
      status: "done",
      ...(entryId === undefined ? {} : { entryId, ...(takenAt === undefined ? {} : { takenAt }) }),
      ...(entryId !== undefined && ended?.lastEntryId ? { lastEntryId: ended.lastEntryId } : {}),
      endedAt: ended?.endedAt ?? stop?.at ?? Date.now(),
      outcome: unansweredOutcome(record.reason, record.detail, stop?.by),
    };
  };

  const textOf = (message: AssistantMessage): string =>
    message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

  /** Usage once per piece of work: on the earliest message that work took. */
  const usageOwner = async (
    conversation: Conversation,
    record: Extract<SubmissionRecord, { status: "done"; type: "input" }>,
    records: EntryRecord[],
  ): Promise<{ usage?: Usage }> => {
    const page = await storage.scanSubmissions(
      { conversationId: conversation.id, status: "done" },
      1000,
      undefined,
      context,
    );
    const sharing = page.items.filter(
      (s): s is typeof record => s.type === "input" && s.status === "done" && s.answer === record.answer,
    );
    const first = sharing.reduce((a, b) => (a.entry <= b.entry ? a : b), record);
    if (first.id !== record.id) return {};
    const from = Math.min(...sharing.map((s) => s.entry));
    const assistant = records
      .filter((r) => r.id >= from && r.id <= record.answer && r.kind === "pi.assistant")
      .map((r) => firstMessage(r) as AssistantMessage);
    const usage = sumUsage(assistant);
    return usage ? { usage } : {};
  };

  const findSubmission = async (conversation: Conversation, messageId: string) =>
    storage.submissionByRequest(conversation.id, messageId, context);

  const stateOf = async (sessionId: string, conversation: Conversation, records: EntryRecord[]) => {
    const [live, inbox, agent, index] = await Promise.all([
      harness.snapshot(LiveDoc, conversation.id, context),
      harness.snapshot(InboxDoc, conversation.id, context),
      conversation.agent(context),
      sessionOf(sessionId),
    ]);
    const requestIdOf = async (id: SubmissionId) => (await storage.submission(id, context))?.requestId as string;
    const takenIds = live?.run?.inputs ?? [];
    const taken = await Promise.all(
      takenIds.map(async (id) => {
        const record = await storage.submission(id, context);
        const own = records.find((r) => r.id === record?.entry);
        return { messageId: record?.requestId as string, takenAt: timestampOf(own) ?? Date.now() };
      }),
    );
    const inputs = (inbox?.items ?? []).filter((item) => item.mode !== "write");
    const ordered = [...inputs.filter((i) => i.mode === "steer"), ...inputs.filter((i) => i.mode === "followUp")];
    const queued = await Promise.all(
      ordered.map(async (item) => {
        const text = typeof item.content === "string" ? item.content : "";
        const data = item.entry?.data as UserData | undefined;
        return {
          messageId: await requestIdOf(item.id),
          ...(data?.idempotencyKey === undefined ? {} : { idempotencyKey: data.idempotencyKey }),
          preview: text.slice(0, PREVIEW_CHARS),
        };
      }),
    );
    const leaf = publish(records, conversation.id).at(-1)?.id;
    const state: SessionState = {
      ...(index?.name === undefined ? {} : { name: index.name }),
      status: live?.run ? "running" : (live?.compactions?.length ?? 0) > 0 ? "compacting" : "idle",
      taken,
      queued,
      ...(agent.model ? { model: `${agent.model.provider}/${agent.model.modelId}` } : {}),
      thinkingLevel: agent.thinkingLevel,
      ...(leaf === undefined ? {} : { leafEntryId: leaf }),
    };
    return state;
  };

  const emitTo = (sessionId: string, event: SessionEvent, after: string | undefined) => {
    for (const listener of listeners.get(sessionId) ?? []) {
      try {
        listener(event, after);
      } catch (error) {
        log.warn(`[fastagent] session listener threw (session ${sessionId}, event ${event.type}): ${String(error)}`);
      }
    }
  };

  /** Write where the work of messages that did not answer ended; its placement also starts the inputs left waiting. */
  const recordEnded = async (conversation: Conversation, data: EndedData): Promise<void> => {
    await conversation.submit({ type: "write", entry: { kind: ENDED, data, edits: [] } }, context);
  };

  /** Follow one conversation's commits: entries and live events, each placed after the newest entry before it. */
  const attach = async (sessionId: string, conversation: Conversation): Promise<void> => {
    if (followed.has(conversation.id)) return;
    followed.add(conversation.id);
    const stream = await watchEvents(harness, conversation.id, context);
    let last = publish(stream.snapshot.entries, conversation.id).at(-1)?.id;
    stream.start(async (events) => {
      const ended: SubmissionId[][] = [];
      for (const event of events) {
        switch (event.type) {
          case "message_end":
          case "entry_appended": {
            const record = event.entry;
            if (record.kind === ENDED) {
              const records = await entriesOf(conversation);
              for (const messageId of (record.data as EndedData).messages) {
                const submission = await findSubmission(conversation, messageId);
                if (submission) {
                  const status = await statusOf(conversation, submission, records);
                  if (status.status === "done") emitTo(sessionId, { type: "done", message: status }, last);
                }
              }
              break;
            }
            const shown = published(record, record.conversationId === conversation.id);
            if (!shown) break;
            const entryEvent: Entry = { ...shown, ...(last === undefined ? {} : { parentEntryId: last }) };
            emitTo(sessionId, { type: "entry", entry: entryEvent }, last);
            last = shown.id;
            break;
          }
          case "message_update":
            for (const change of event.changes) {
              if (change.type === "text_delta" || change.type === "thinking_delta") {
                if (change.delta === "") continue;
                const channel = change.type === "text_delta" ? "text" : "thinking";
                emitTo(sessionId, { type: "message_delta", channel, delta: change.delta }, last);
              }
            }
            break;
          case "tool_execution_start":
            if (event.parentToolCallId === undefined) {
              const started = { toolCallId: event.toolCallId, name: event.toolName, args: event.args as Json };
              emitTo(sessionId, { type: "tool_started", ...started }, last);
            }
            break;
          case "auto_retry_start":
            emitTo(
              sessionId,
              {
                type: "retry_scheduled",
                attempt: event.attempt,
                maxAttempts: options.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
                delayMs: Math.max(0, event.at - Date.now()),
                reason: event.errorMessage,
              },
              last,
            );
            break;
          case "run_end":
            ended.push([...event.inputs]);
            break;
          case "submission": {
            const record = event.record;
            if (record.type !== "input" || record.requestId === undefined) break;
            const needsEnd = record.status === "unanswered" && record.entry !== undefined;
            if (record.status === "done" || (record.status === "unanswered" && !needsEnd)) {
              const status = await statusOf(conversation, record, await entriesOf(conversation));
              if (status.status === "done") emitTo(sessionId, { type: "done", message: status }, last);
            }
            break;
          }
          default:
            break;
        }
      }
      for (const inputs of ended) {
        const records = await Promise.all(inputs.map((id) => storage.submission(id, context)));
        const unanswered = records.filter(
          (r): r is SubmissionRecord => r?.type === "input" && r.status === "unanswered" && r.entry !== undefined,
        );
        if (unanswered.length === 0) continue;
        await recordEnded(conversation, {
          messages: unanswered.map((r) => r.requestId as string),
          lastEntryId: last ?? null,
          endedAt: Date.now(),
        });
      }
      if (
        listeners.has(sessionId) &&
        events.some((e) => e.type === "submission" || e.type === "inbox_update" || e.type.startsWith("run_"))
      ) {
        const records = await entriesOf(conversation);
        emitTo(sessionId, { type: "state", state: await stateOf(sessionId, conversation, records) }, last);
      }
    });
  };

  /** Messages whose work ended without an answer before their end was written: written before anything else. */
  const reconcile = async (conversation: Conversation): Promise<void> => {
    const records = await entriesOf(conversation);
    const ended = endedRecords(records);
    const page = await storage.scanSubmissions(
      { conversationId: conversation.id, status: "unanswered" },
      1000,
      undefined,
      context,
    );
    const missing = page.items.filter(
      (r) => r.type === "input" && r.entry !== undefined && r.requestId !== undefined && !ended.has(r.requestId),
    );
    if (missing.length === 0) return;
    await recordEnded(conversation, {
      messages: missing.map((r) => r.requestId as string),
      lastEntryId: publish(records, conversation.id).at(-1)?.id ?? null,
      endedAt: Date.now(),
    });
  };

  const createConversation = async (sessionId: string): Promise<Conversation> => {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          ...(options.model ? { model: options.model } : {}),
          ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel as never } : {}),
        },
        init: async (tx, id) => {
          (await tx.doc(Sessions)).byId[sessionId] = {
            conversationId: id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        },
      },
      context,
    );
    await attach(sessionId, conversation);
    return conversation;
  };

  const serially = <A>(sessionId: string, work: () => Promise<A>): Promise<A> => {
    const previous = admissions.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    admissions.set(
      sessionId,
      next.catch(() => {}),
    );
    return next;
  };

  const notFound = (sessionId: string) => failure("not_found", `no session ${sessionId}`);

  const inFlight = async (): Promise<number> =>
    (await harness.inspect(context)).submissions.filter((s) => s.type === "input").length;

  const port: HarnessPort = {
    capabilities,

    submit: (sessionId, prompt: Prompt, { whenBusy, idempotencyKey, source }) =>
      serially(sessionId, async () => {
        const existing = await conversationOf(sessionId);
        const requestId = idempotencyKey === undefined ? `m:${crypto.randomUUID()}` : `k:${idempotencyKey}`;
        if (existing && idempotencyKey !== undefined) {
          const known = await findSubmission(existing, requestId);
          if (known) {
            return {
              ok: true as const,
              message: await statusOf(existing, known, await entriesOf(existing)),
              duplicate: true,
            };
          }
        }
        if (existing) {
          const inbox = await harness.snapshot(InboxDoc, existing.id, context);
          const queued = (inbox?.items ?? []).filter((item) => item.mode !== "write").length;
          if (queued >= LIMITS.queuedPerSession) {
            return failure("busy", `the session already has ${queued} queued messages`, { reason: "queue_full" });
          }
        }
        const limit = options.inFlightPerProcess ?? LIMITS.inFlightPerProcess;
        const flying = await inFlight();
        if (flying >= limit) {
          return failure("busy", `this process already has ${flying} messages in flight`, { reason: "capacity" });
        }
        const conversation = existing ?? (await createConversation(sessionId));
        const content = [
          { type: "text" as const, text: prompt.text },
          ...(prompt.images ?? []).map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ];
        const data: UserData = {
          messageId: requestId,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          source,
        };
        try {
          const submission = await conversation.submit(
            {
              type: "input",
              content: prompt.images?.length ? content : prompt.text,
              requestId,
              whenBusy: whenBusy === "queue" ? "followUp" : whenBusy,
              entry: { kind: USER, data },
            },
            context,
          );
          const record = await submission.status(context);
          await conversation.commit(async (tx) => {
            const own = (await tx.doc(Sessions)).byId[sessionId];
            if (own) own.updatedAt = Date.now();
          }, context);
          return {
            ok: true as const,
            message: await statusOf(conversation, record, await entriesOf(conversation)),
            duplicate: false,
          };
        } catch (error) {
          if (error instanceof ConversationBusy) {
            return failure("busy", "the session is working", { reason: "running" });
          }
          throw error;
        }
      }),

    getMessage: async (sessionId, key) => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return undefined;
      const requestId = "messageId" in key ? key.messageId : `k:${key.idempotencyKey}`;
      const record = await findSubmission(conversation, requestId);
      return record ? statusOf(conversation, record, await entriesOf(conversation)) : undefined;
    },

    messageEntries: async (sessionId, messageId, after) => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      const record = await findSubmission(conversation, messageId);
      if (!record) return failure("not_found", `no message ${messageId}`);
      const records = await entriesOf(conversation);
      const message = await statusOf(conversation, record, records);
      const entries = publish(records, conversation.id);
      const cursor = after === undefined ? -1 : entries.findIndex((entry) => entry.id === after);
      if (after !== undefined && cursor < 0) return failure("not_found", `no entry ${after}`);
      if (message.status === "queued" || message.entryId === undefined) {
        return { ok: true as const, message, entries: [], ended: message.status === "done" };
      }
      const { entryId } = message;
      const first = Math.max(
        entries.findIndex((entry) => entry.id === entryId),
        cursor + 1,
      );
      const last =
        message.status === "done" && message.lastEntryId !== undefined
          ? entries.findIndex((entry) => entry.id === message.lastEntryId)
          : entries.length - 1;
      return { ok: true as const, message, entries: entries.slice(first, last + 1), ended: true };
    },

    cancelMessage: async (sessionId, messageId) => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      const record = await findSubmission(conversation, messageId);
      if (!record) return failure("not_found", `no message ${messageId}`);
      if (record.status === "done" || record.status === "unanswered") {
        return failure("conflict", `message ${messageId} is done`);
      }
      await conversation.commit(async (tx) => {
        (await tx.doc(Stops, conversation.id)).byMessage[messageId] = { by: "cancel", at: Date.now() };
      }, context);
      const submission = await harness.submission(record.id, context);
      if (record.status === "queued" && (await submission?.abort(context)) === "aborted") return { ok: true };
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      if (live?.run) await harness.abortTask(live.run.taskId, context);
      return { ok: true };
    },

    abort: async (sessionId): Promise<AbortResult> => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      const records = await entriesOf(conversation);
      const state = await stateOf(sessionId, conversation, records);
      const taken = state.taken.map((t) => t.messageId);
      const queued = state.queued.map((q) => q.messageId);
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      const compaction = (live?.compactions?.length ?? 0) > 0;
      if (taken.length + queued.length > 0) {
        await conversation.commit(async (tx) => {
          const stops = await tx.doc(Stops, conversation.id);
          for (const id of [...taken, ...queued]) stops.byMessage[id] = { by: "abort", at: Date.now() };
        }, context);
      }
      await conversation.abort(context);
      return { ok: true, stopped: { taken, queued, compaction } };
    },

    read: async (sessionId, page: Page): Promise<PortRead> => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      const records = await entriesOf(conversation);
      const entries = publish(records, conversation.id);
      const state = await stateOf(sessionId, conversation, records);
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
    },

    watch: (sessionId, listener) => {
      const set = listeners.get(sessionId) ?? new Set();
      listeners.set(sessionId, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(sessionId) === set) listeners.delete(sessionId);
      };
    },

    attachment: async (sessionId, ref) => {
      const conversation = await conversationOf(sessionId);
      const at = parseImageRef(ref);
      if (!conversation || !at) return undefined;
      const found = await storage.entry(conversation.id, Number(at.entryId) as EntryId, context);
      const message = found && firstMessage(found.entry);
      return message ? imageIn(message, at.index) : undefined;
    },

    create: async (sessionId, fork): Promise<Result> => {
      if (await sessionOf(sessionId)) return failure("conflict", `session ${sessionId} exists`);
      if (!fork) {
        await createConversation(sessionId);
        return { ok: true };
      }
      const source = await conversationOf(fork.sessionId);
      if (!source) return notFound(fork.sessionId);
      const entries = publish(await entriesOf(source), source.id);
      const at = fork.entryId ?? entries.at(-1)?.id;
      if (at === undefined) {
        await createConversation(sessionId);
        return { ok: true };
      }
      if (!entries.some((entry) => entry.id === at)) {
        return failure("not_found", `no entry ${at} in session ${fork.sessionId}`);
      }
      const forked = await source.fork(
        Number(at) as EntryId,
        {
          ownership: { kind: "ownerless" },
          init: async (tx, id) => {
            (await tx.doc(Sessions)).byId[sessionId] = {
              conversationId: id,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
          },
        },
        context,
      );
      await attach(sessionId, forked);
      return { ok: true };
    },

    rewind: async () => failure("unsupported", "this agent cannot rewind a session"),

    compact: async (sessionId, compactOptions = {}): Promise<Result> => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      if (live?.run) return failure("busy", "the session is working", { reason: "running" });
      if (!publish(await entriesOf(conversation), conversation.id).some((e) => e.kind !== "compaction")) {
        return failure("nothing_to_compact", "nothing to compact");
      }
      const task = await conversation.compact(compactOptions.instructions, context);
      const settled = await harness.waitForTask(task, context);
      const outcome = settled.state.outcome;
      if (outcome.status !== "completed") {
        return failure("internal", `the compaction ended ${outcome.status}`);
      }
      return outcome.result.entryId === undefined && outcome.result.submissionId === undefined
        ? failure("nothing_to_compact", "nothing to compact")
        : { ok: true };
    },

    update: async (sessionId, settings): Promise<Result> => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      if (settings.name !== undefined && settings.name.trim() === "") {
        return failure("invalid_request", "a session name cannot be empty");
      }
      let model: { provider: string; modelId: string } | undefined;
      if (settings.model !== undefined) {
        const known = (await options.models()).find((m) => m.spec === settings.model);
        if (!known)
          return failure("invalid_request", `unknown model "${settings.model}": models() lists the accepted models`);
        const slash = settings.model.indexOf("/");
        model = { provider: settings.model.slice(0, slash), modelId: settings.model.slice(slash + 1) };
      }
      const name = settings.name;
      if (name !== undefined) {
        await conversation.commit(async (tx) => {
          const index = await tx.doc(Sessions);
          const own = index.byId[sessionId];
          if (own) own.name = name;
        }, context);
      }
      if (model || settings.thinkingLevel !== undefined) {
        await conversation.configure(
          {
            ...(model ? { model } : {}),
            ...(settings.thinkingLevel !== undefined ? { thinkingLevel: settings.thinkingLevel as never } : {}),
          },
          context,
        );
      }
      return { ok: true };
    },

    delete: async () => failure("unsupported", "this agent cannot delete a session"),

    list: async () => {
      const index = (await harness.snapshot(Sessions, context))?.byId ?? {};
      const summaries = await Promise.all(
        Object.entries(index).map(async ([sessionId, own]) => {
          const live = await harness.snapshot(LiveDoc, own.conversationId as ConversationId, context);
          return {
            sessionId,
            ...(own.name === undefined ? {} : { name: own.name }),
            status: live?.run ? ("running" as const) : ("idle" as const),
            createdAt: own.createdAt,
            updatedAt: own.updatedAt,
          };
        }),
      );
      return summaries;
    },

    models: () => options.models(),
    commands: async () => (await options.commands?.()) ?? [],
  };

  // A previous process may have stopped between a run that did not answer and the write that records its end.
  const index = (await harness.snapshot(Sessions, context))?.byId ?? {};
  for (const [sessionId, own] of Object.entries(index)) {
    const conversation = await harness.conversation(own.conversationId as ConversationId, context);
    if (!conversation) throw new Error(`session ${sessionId} names conversation ${own.conversationId}, which is gone`);
    await attach(sessionId, conversation);
    await reconcile(conversation);
  }
  return port;
}
