/**
 * pi-durable as a `HarnessPort` (docs/design/agent-service.md §9.1): a durable harness, implementing the port directly.
 * Its submissions are the message records (each settles once, in the commit with the entries it settles with), its
 * inbox is the queue, its runs continue after a restart. What the port adds is the protocol's naming and five facts
 * pi-durable does not keep:
 *
 * - which messages a conversation still owes an outcome (`fastagent.pending`): what is followed, and what can still
 *   read `taken` after its work stopped;
 * - which session id names which conversation, and its name (`fastagent.sessions`);
 * - why a message was canceled (`fastagent.stops`), since pi-durable says only `aborted`;
 * - where the work of a message that did not answer ended (`fastagent.ends`), written as soon as the run's end is seen,
 *   and then a write that places the inputs pi-durable leaves waiting behind a run that failed or was aborted;
 * - a message id: the request id, `k:<key>` or `m:<minted>`, so its native dedup by request id is the protocol's.
 */
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  ConversationBusy,
  configure,
  DEFAULT_RETRY_POLICY,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  InboxDoc,
  LiveDoc,
  type Storage,
  type AgentEvent,
  type SubmissionId,
  type SubmissionRecord,
  type Tx,
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
  type ForkSource,
  type Result,
  type SessionEvent,
  type SessionState,
  type Usage,
  agentError,
  failure,
} from "../../protocol.ts";
import { imageIn, parseImageRef } from "../pi/entry-images.ts";
import { messageRecord } from "../pi/log-records.ts";

/**
 * A document changed by a delta per message is stored as a whole value every so often, so a cold read replays at most
 * that many deltas rather than every one since it was created.
 */
const checkpointOften = (_value: unknown, _ops: unknown, info: { deltasSinceBase: number }) =>
  info.deltasSinceBase >= 32;

type SessionIndex = {
  byId: { [sessionId: string]: { conversationId: number; createdAt: number; name?: string } };
};

const Sessions = defineDoc<SessionIndex>({
  kind: "fastagent.sessions",
  version: 1,
  checkpointWhen: checkpointOften,
  scope: "session",
  initial: () => ({ byId: {} }),
});

/** A session id another conversation already holds: the creating commit is rolled back. */
class SessionExists extends Error {}

/** Name `conversationId` `sessionId`, in the commit that creates it, unless another conversation holds that id. */
async function claimSession(tx: Tx, sessionId: string, conversationId: ConversationId): Promise<void> {
  const index = await tx.doc(Sessions);
  if (index.byId[sessionId]) throw new SessionExists(`session ${sessionId} exists`);
  index.byId[sessionId] = { conversationId, createdAt: Date.now() };
}

/**
 * The messages each conversation owes an outcome: marked before a message is submitted, cleared once its `done` is
 * reported. It is what is in flight, kept small by construction, so nothing has to scan history to find it: which
 * conversations to follow, and which messages may still read `taken` after their work stopped.
 */
const Pending = defineDoc<{ byConversation: { [conversationId: string]: { [messageId: string]: true } } }>({
  kind: "fastagent.pending",
  version: 1,
  checkpointWhen: checkpointOften,
  scope: "session",
  initial: () => ({ byConversation: {} }),
});

type StopReason = "cancel" | "abort" | "delete";

const Stops = defineDoc<{ byMessage: { [messageId: string]: { by: StopReason; at: number } } }>({
  kind: "fastagent.stops",
  version: 1,
  checkpointWhen: checkpointOften,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ byMessage: {} }),
});

/** A message's own entry: the input, placed as this kind so it carries its id, key and source. */
const USER = "fastagent.user";
/**
 * Where the work of each message that did not answer ended, and when: written as a document, in a commit of its own
 * that waits for nothing, as soon as the run's end is seen. An input pi-durable leaves waiting behind such a run is
 * placed by a separate write of this kind, which the history does not publish.
 */
const Ends = defineDoc<{ byMessage: { [messageId: string]: { lastEntryId: string | null; endedAt: number } } }>({
  kind: "fastagent.ends",
  version: 1,
  checkpointWhen: checkpointOften,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ byMessage: {} }),
});
const PLACE = "fastagent.place";

type UserData = { messageId: string; idempotencyKey?: string; source: MessageSource };

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
  /**
   * The conversations followed now: one owing an outcome to a message (so its ends are written as they happen), or one
   * someone is listening to. An idle one nobody listens to is not, and holds nothing in this process. The promise is the
   * attachment in progress, so two first uses share one; one that failed is forgotten, and tried again.
   */
  const followed = new Map<number, Promise<{ stop: () => Promise<unknown> }>>();
  /** One admission at a time per session: looking a key up and submitting under it are one step (SPEC v1 §3.3). */
  const admissions = new Map<string, Promise<unknown>>();

  const sessionOf = async (sessionId: string) => (await harness.snapshot(Sessions, context))?.byId[sessionId];

  const updatedAtOf = async (conversationId: ConversationId, createdAt: number): Promise<number> => {
    const conversation = await harness.conversation(conversationId, context);
    const newest = conversation && (await newestPublished(conversation));
    const record = newest === undefined || !conversation ? undefined : await entryAt(conversation, Number(newest));
    return timestampOf(record) ?? createdAt;
  };

  const conversationOf = async (sessionId: string): Promise<Conversation | undefined> => {
    const known = await sessionOf(sessionId);
    if (known === undefined) return undefined;
    const conversation = await harness.conversation(known.conversationId as ConversationId, context);
    if (!conversation) {
      throw new Error(`session ${sessionId} names conversation ${known.conversationId}, which is gone`);
    }
    return conversation;
  };

  /** The messages a conversation owes an outcome (`Pending`). */
  const pendingOf = async (conversationId: ConversationId): Promise<string[]> =>
    Object.keys((await harness.snapshot(Pending, context))?.byConversation[conversationId] ?? {});

  /** One entry of a conversation's history, its forked-from part included. */
  const entryAt = async (conversation: Conversation, id: number | undefined): Promise<EntryRecord | undefined> =>
    id === undefined ? undefined : (await storage.entry(conversation.id, id as EntryId, context))?.entry;

  /** Entries from `from` on (newest first when descending), one page at a time, until `stop` says so. */
  const scanEntries = async (
    conversation: Conversation,
    query: { minEntryId?: number; maxEntryId?: number; order: "ascending" | "descending" },
    stop: (record: EntryRecord) => boolean,
  ): Promise<void> => {
    let cursor: Parameters<Conversation["entries"]>[2];
    const { order, minEntryId, maxEntryId } = query;
    do {
      const page = await conversation.entries(
        {
          order,
          ...(minEntryId === undefined ? {} : { minEntryId: minEntryId as EntryId }),
          ...(maxEntryId === undefined ? {} : { maxEntryId: maxEntryId as EntryId }),
        },
        100,
        cursor,
        context,
      );
      for (const record of page.items) if (stop(record)) return;
      cursor = page.next;
    } while (cursor !== undefined);
  };

  /** A record as published in this conversation: a fork's inherited entries are history, and name no message. */
  const shown = (conversation: Conversation, record: EntryRecord) =>
    published(record, record.conversationId === conversation.id);

  /** The newest published entry at or before `at` (the whole history without it): the head a caller sees. */
  const publishedBefore = async (conversation: Conversation, at?: number): Promise<string | undefined> => {
    let found: string | undefined;
    const query = at === undefined ? {} : { maxEntryId: at };
    await scanEntries(conversation, { ...query, order: "descending" }, (record) => {
      found = shown(conversation, record) ? idOf(record.id) : undefined;
      return found !== undefined;
    });
    return found;
  };
  const newestPublished = (conversation: Conversation) => publishedBefore(conversation);

  /**
   * Up to `limit` published entries from a range, in history order, each naming the published entry before it as its
   * parent: what one page of a read is. `more` says whether one more lies past the range's far end in its direction.
   */
  const publishedRange = async (
    conversation: Conversation,
    range: { minEntryId?: number; maxEntryId?: number; order: "ascending" | "descending" },
    limit: number,
  ): Promise<{ entries: Entry[]; more: boolean }> => {
    const found: Omit<Entry, "parentEntryId">[] = [];
    await scanEntries(conversation, range, (record) => {
      const entry = shown(conversation, record);
      if (entry) found.push(entry);
      return found.length > limit;
    });
    const more = found.length > limit;
    const page = found.slice(0, limit);
    if (range.order === "descending") page.reverse();
    const first = page[0];
    let parent = first === undefined ? undefined : await publishedBefore(conversation, Number(first.id) - 1);
    const entries = page.map((entry) => {
      const linked: Entry = parent === undefined ? entry : { ...entry, parentEntryId: parent };
      parent = entry.id;
      return linked;
    });
    return { entries, more };
  };

  /** Whether `id` names an entry this conversation publishes: what a cursor must be. */
  const isPublished = async (conversation: Conversation, id: string): Promise<boolean> => {
    if (!/^[1-9]\d*$/.test(id)) return false;
    const record = await entryAt(conversation, Number(id));
    return record !== undefined && shown(conversation, record) !== undefined;
  };

  /**
   * The messages taken now: the run's inputs, and those its work stopped without an answer whose end is not written
   * yet. ONE answer for every plane: a message's status, the session's state.
   */
  const takenOf = async (conversationId: ConversationId): Promise<SubmissionRecord[]> => {
    const [live, ends] = await Promise.all([
      harness.snapshot(LiveDoc, conversationId, context),
      harness.snapshot(Ends, conversationId, context),
    ]);
    const running = await Promise.all((live?.run?.inputs ?? []).map((id) => storage.submission(id, context)));
    // Only a message still owed an outcome can have stopped without its end written.
    const owed = await Promise.all(
      (await pendingOf(conversationId)).map((messageId) =>
        storage.submissionByRequest(conversationId, messageId, context),
      ),
    );
    const ending = owed.filter(
      (r): r is SubmissionRecord =>
        r?.status === "unanswered" && r.entry !== undefined && !ends?.byMessage[r.requestId as string],
    );
    return [...running.filter((r): r is SubmissionRecord => r !== undefined), ...ending];
  };
  /** Whether a session works: some message is taken. The state and the session list both say it through this. */
  const isBusy = async (conversationId: ConversationId) => (await takenOf(conversationId)).length > 0;

  /** A message's status from its submission and the conversation's committed state. */
  const statusOf = async (conversation: Conversation, record: SubmissionRecord): Promise<MessageStatus> => {
    const messageId = record.requestId as string;
    const own = await entryAt(conversation, record.entry);
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
    const taken = { ...base, status: "taken" as const, entryId: entryId as string, takenAt: takenAt ?? Date.now() };
    if (record.status === "placed") return taken;
    if (record.type !== "input") throw new Error(`submission ${record.id} is not an input`);
    if (record.status === "done") {
      const answer = await entryAt(conversation, record.answer);
      const message = answer && (firstMessage(answer) as AssistantMessage | undefined);
      return {
        ...base,
        status: "done",
        ...(entryId === undefined ? {} : { entryId, ...(takenAt === undefined ? {} : { takenAt }) }),
        lastEntryId: idOf(record.answer),
        endedAt: timestampOf(answer) ?? Date.now(),
        outcome: message?.stopReason === "length" ? { status: "max_tokens" } : { status: "completed" },
        ...(await usageOwner(conversation, record.entry, record.answer)),
        ...(message ? { answer: { entryId: idOf(record.answer), text: textOf(message) } } : {}),
      };
    }
    const [stops, ends] = await Promise.all([
      harness.snapshot(Stops, conversation.id, context),
      harness.snapshot(Ends, conversation.id, context),
    ]);
    const stop = stops?.byMessage[messageId];
    const ended = ends?.byMessage[messageId];
    // Taken, and its work stopped, but where that work ended is not written yet: it is done once it is.
    if (entryId !== undefined && ended === undefined) return taken;
    return {
      ...base,
      status: "done",
      ...(entryId === undefined ? {} : { entryId, ...(takenAt === undefined ? {} : { takenAt }) }),
      ...(entryId !== undefined && ended?.lastEntryId ? { lastEntryId: ended.lastEntryId } : {}),
      endedAt: ended?.endedAt ?? stop?.at ?? Date.now(),
      outcome: unansweredOutcome(record.reason, record.detail, stop?.by),
      ...(record.entry !== undefined && ended?.lastEntryId
        ? await usageOwner(conversation, record.entry, Number(ended.lastEntryId))
        : {}),
    };
  };

  const textOf = (message: AssistantMessage): string =>
    message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

  /** The message a user entry is, by the id it carries; a plain `pi.user` entry (not admitted by this port) is none. */
  const messageOfEntry = (record: EntryRecord): string | undefined =>
    record.kind === USER ? (record.data as UserData).messageId : undefined;
  const isUserEntry = (record: EntryRecord) => record.kind === USER || record.kind === "pi.user";

  /** Where a message's work ended: its answer, or the end recorded for work that did not answer. */
  const workEndOf = async (conversation: Conversation, record: SubmissionRecord): Promise<number | undefined> => {
    if (record.type !== "input") return undefined;
    if (record.status === "done") return record.answer;
    if (record.status !== "unanswered" || record.requestId === undefined) return undefined;
    const ended = (await harness.snapshot(Ends, conversation.id, context))?.byMessage[record.requestId];
    return ended?.lastEntryId ? Number(ended.lastEntryId) : undefined;
  };

  /**
   * Usage once per piece of work, however it ended, on the earliest message it took. Whether an earlier one shares
   * this work is the submissions' to say, not the entries' shape: the nearest user entry before this one is the same
   * work's exactly when its message's work ended at the same place (an answer, or a recorded end). Then the work's
   * answers, from this entry to that end, add up.
   */
  const usageOwner = async (conversation: Conversation, entry: number, workEnd: number): Promise<{ usage?: Usage }> => {
    let previous: EntryRecord | undefined;
    await scanEntries(conversation, { maxEntryId: entry - 1, order: "descending" }, (record) => {
      if (isUserEntry(record)) previous = record;
      return previous !== undefined;
    });
    const previousId = previous && messageOfEntry(previous);
    const before = previousId === undefined ? undefined : await findSubmission(conversation, previousId);
    if (before && (await workEndOf(conversation, before)) === workEnd) return {};
    const answers: AssistantMessage[] = [];
    await scanEntries(conversation, { minEntryId: entry, maxEntryId: workEnd, order: "ascending" }, (e) => {
      if (e.kind === "pi.assistant") answers.push(firstMessage(e) as AssistantMessage);
      return false;
    });
    const usage = sumUsage(answers);
    return usage ? { usage } : {};
  };

  const findSubmission = async (conversation: Conversation, messageId: string) =>
    storage.submissionByRequest(conversation.id, messageId, context);

  const stateOf = async (sessionId: string, conversation: Conversation): Promise<SessionState> => {
    const [live, inbox, agent, index, takenRecords, leaf] = await Promise.all([
      harness.snapshot(LiveDoc, conversation.id, context),
      harness.snapshot(InboxDoc, conversation.id, context),
      conversation.agent(context),
      sessionOf(sessionId),
      takenOf(conversation.id),
      newestPublished(conversation),
    ]);
    const taken = await Promise.all(
      takenRecords.map(async (record) => ({
        messageId: record.requestId as string,
        takenAt: timestampOf(await entryAt(conversation, record.entry)) ?? Date.now(),
      })),
    );
    const inputs = (inbox?.items ?? []).filter((item) => item.mode !== "write");
    const ordered = [...inputs.filter((i) => i.mode === "steer"), ...inputs.filter((i) => i.mode === "followUp")];
    const queued = await Promise.all(
      ordered.map(async (item) => {
        const content = item.content as unknown;
        const text =
          typeof content === "string"
            ? content
            : (content as { type?: string; text?: string }[])
                .flatMap((b) => (b.type === "text" ? [b.text ?? ""] : []))
                .join("");
        const data = item.entry?.data as UserData | undefined;
        return {
          messageId: (await storage.submission(item.id, context))?.requestId as string,
          ...(data?.idempotencyKey === undefined ? {} : { idempotencyKey: data.idempotencyKey }),
          preview: text.slice(0, PREVIEW_CHARS),
        };
      }),
    );
    const busy = taken.length > 0;
    return {
      ...(index?.name === undefined ? {} : { name: index.name }),
      status: busy ? "running" : (live?.compactions?.length ?? 0) > 0 ? "compacting" : "idle",
      taken,
      queued,
      ...(agent.model ? { model: `${agent.model.provider}/${agent.model.modelId}` } : {}),
      thinkingLevel: agent.thinkingLevel,
      ...(leaf === undefined ? {} : { leafEntryId: leaf }),
    };
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

  /**
   * Write where the work of messages that did not answer ended, in a commit that waits for nothing, then place the
   * inputs pi-durable left waiting behind that work (it places them only at the next input or write).
   */
  const recordEnded = async (
    conversation: Conversation,
    ended: readonly { messageId: string; lastEntryId: string | null }[],
  ): Promise<void> => {
    await conversation.commit(async (tx) => {
      const ends = (await tx.doc(Ends, conversation.id)).byMessage;
      for (const { messageId, lastEntryId } of ended) ends[messageId] ??= { lastEntryId, endedAt: Date.now() };
    }, context);
    const [live, inbox] = await Promise.all([
      harness.snapshot(LiveDoc, conversation.id, context),
      harness.snapshot(InboxDoc, conversation.id, context),
    ]);
    if (live?.run === undefined && (inbox?.items ?? []).some((item) => item.mode !== "write")) {
      await conversation.submit({ type: "write", entry: { kind: PLACE, edits: [] } }, context);
    }
  };

  /** Report a message done, and stop owing it: its outcome is recorded, by pi-durable or as its end. */
  const emitDone = async (
    sessionId: string,
    conversation: Conversation,
    status: MessageStatus,
    after: string | undefined,
  ): Promise<void> => {
    if (status.status !== "done") return;
    emitTo(sessionId, { type: "done", message: status }, after);
    await conversation.commit(async (tx) => {
      const owed = (await tx.doc(Pending)).byConversation[conversation.id];
      if (owed) delete owed[status.messageId];
      if (owed && Object.keys(owed).length === 0) delete (await tx.doc(Pending)).byConversation[conversation.id];
    }, context);
  };

  /** Stop owing a message that was never admitted. */
  const disown = async (conversation: Conversation, messageId: string): Promise<void> => {
    await conversation.commit(async (tx) => {
      const pending = await tx.doc(Pending);
      const owed = pending.byConversation[conversation.id];
      if (owed) delete owed[messageId];
      if (owed && Object.keys(owed).length === 0) delete pending.byConversation[conversation.id];
    }, context);
  };

  /** Owe `messageId` an outcome: written before it is submitted, so a process that stops in between still knows. */
  const owe = async (conversation: Conversation, messageId: string): Promise<void> => {
    await conversation.commit(async (tx) => {
      const pending = await tx.doc(Pending);
      const owed = pending.byConversation[conversation.id] ?? {};
      owed[messageId] = true;
      pending.byConversation[conversation.id] = owed;
    }, context);
  };

  /**
   * Follow one conversation's commits. The stream's callback only queues each batch: the work a batch needs (reads,
   * the end write) runs on the conversation's own queue, in order, so a slow read never backs pi-durable's stream up into
   * the snapshot it sends instead of what it dropped, and a failed job is said and the next batch still runs.
   */
  // A failed attachment (pi-durable refusing the watch) is not reproduced in tests: `watchEvents` is not injectable.
  const attach = async (sessionId: string, conversation: Conversation): Promise<void> => {
    const known = followed.get(conversation.id);
    if (known) {
      await known;
      return;
    }
    const attaching = follow(sessionId, conversation);
    followed.set(conversation.id, attaching);
    attaching.catch(() => {
      if (followed.get(conversation.id) === attaching) followed.delete(conversation.id);
    });
    await attaching;
  };

  /**
   * Stop following a conversation nobody listens to that owes no message an outcome. Under the session's admission
   * lock, so a message submitted meanwhile, which follows it again, cannot be missed.
   */
  const release = (sessionId: string, conversationId: ConversationId): Promise<void> =>
    serially(sessionId, async () => {
      const following = followed.get(conversationId);
      if (!following || listeners.has(sessionId) || (await pendingOf(conversationId)).length > 0) return;
      followed.delete(conversationId);
      await (await following).stop();
    });

  const follow = async (sessionId: string, conversation: Conversation): Promise<{ stop: () => Promise<unknown> }> => {
    const stream = await watchEvents(harness, conversation.id, context);
    const newest = [...stream.snapshot.entries].reverse().find((record) => shown(conversation, record));
    let last = newest === undefined ? undefined : idOf(newest.id);
    let queue = Promise.resolve();
    /**
     * A failed job is logged and made good once by a resync, which writes and reports what it would have, from the log.
     * Only a resync that fails too reaches the followers, as a `serving_error`: they cannot be made whole.
     */
    const later = (job: () => Promise<void>, recover = true) => {
      queue = queue.then(job).catch((error: unknown) => {
        const message = `session ${sessionId}: following its work failed: ${String(error)}`;
        log.error(`[fastagent] ${message}`);
        if (recover) later(resync, false);
        else emitTo(sessionId, { type: "serving_error", message }, last);
      });
    };
    const statusById = async (id: SubmissionId) => {
      const record = await storage.submission(id, context);
      return record && statusOf(conversation, record);
    };
    const reportEnded = async (messages: readonly string[]) => {
      for (const messageId of messages) {
        const record = await findSubmission(conversation, messageId);
        // One not admitted yet is being submitted now: owed before it is (see `owe`).
        if (record) await emitDone(sessionId, conversation, await statusOf(conversation, record), last);
      }
    };

    /** A gap: what the stream dropped is read back from the log, then every end owed is written and reported. */
    const resync = async () => {
      const { entries } = await publishedRange(
        conversation,
        { ...(last === undefined ? {} : { minEntryId: Number(last) + 1 }), order: "ascending" },
        Number.POSITIVE_INFINITY,
      );
      for (const entry of entries) {
        emitTo(sessionId, { type: "entry", entry }, last);
        last = entry.id;
      }
      await reconcile(conversation);
      await reportEnded(await pendingOf(conversation.id));
      if (listeners.has(sessionId)) {
        emitTo(sessionId, { type: "state", state: await stateOf(sessionId, conversation) }, last);
      }
    };

    const handle = async (events: readonly AgentEvent[]) => {
      const ended: SubmissionId[][] = [];
      for (const event of events) {
        switch (event.type) {
          // pi-durable sends one after dropping frames a slow listener did not take (more than 100 behind). This
          // listener only queues, so that is not reproduced in tests; a failed job takes the same resync, and that is.
          case "snapshot":
            await resync();
            break;
          case "message_end":
          case "entry_appended": {
            const record = event.entry;
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
            // One that ended without an answer after it was taken is done once its end is written (below).
            const needsEnd = record.status === "unanswered" && record.entry !== undefined;
            if (record.status === "done" || (record.status === "unanswered" && !needsEnd)) {
              const status = await statusById(record.id);
              if (status) await emitDone(sessionId, conversation, status, last);
            }
            break;
          }
          default:
            break;
        }
      }
      // `last` is the newest entry of the commit the run ended in: where its work ended, exactly.
      for (const inputs of ended) {
        const records = await Promise.all(inputs.map((id) => storage.submission(id, context)));
        const unanswered = records.filter(
          (r): r is SubmissionRecord => r?.type === "input" && r.status === "unanswered" && r.entry !== undefined,
        );
        if (unanswered.length === 0) continue;
        const messages = unanswered.map((r) => r.requestId as string);
        await recordEnded(
          conversation,
          messages.map((messageId) => ({ messageId, lastEntryId: last ?? null })),
        );
        await reportEnded(messages);
      }
      if (
        listeners.has(sessionId) &&
        events.some((e) => e.type === "submission" || e.type === "inbox_update" || e.type.startsWith("run_"))
      ) {
        emitTo(sessionId, { type: "state", state: await stateOf(sessionId, conversation) }, last);
      }
    };

    stream.start(async (events) => {
      later(async () => {
        await handle(events);
        await release(sessionId, conversation.id);
      });
    });
    // What happened before the stream started (a previous process's, or between this one's reads) is made good first.
    later(resync);
    // A stream that ended for any reason but the harness closing is followed again, and what it missed made good. Not
    // reproduced in tests: this listener never throws, the end pi-durable reports as `listener_error`.
    void stream.closed.then((end) => {
      if (end.reason === "stopped" || end.reason === "session_closed" || end.reason === "cancelled") return;
      followed.delete(conversation.id);
      const why = "error" in end ? String(end.error) : end.reason;
      log.error(`[fastagent] session ${sessionId}: its event stream ended (${why}); following it again`);
      later(() => attach(sessionId, conversation), false);
    });
    return { stop: () => stream.stop() };
  };

  /**
   * Messages whose work ended without an answer before their end was written: written before anything else. Only a
   * conversation with such a message reads its history.
   */
  const reconcile = async (conversation: Conversation): Promise<void> => {
    const live = await harness.snapshot(LiveDoc, conversation.id, context);
    const running = new Set(live?.run?.inputs ?? []);
    const missing = (await takenOf(conversation.id)).filter((r) => !running.has(r.id));
    if (missing.length === 0) return;
    // The exact end was lost with the moment it was seen. Each message's work ended at its last published entry before
    // a user entry of a message that is not one of these: work that started since is another message's. Should two
    // runs in a row both have gone unrecorded, they read as one.
    const ending = new Set(missing.map((r) => r.requestId as string));
    const ended = await Promise.all(
      missing.map(async (r) => {
        let lastEntryId = idOf(r.entry as number);
        await scanEntries(conversation, { minEntryId: (r.entry as number) + 1, order: "ascending" }, (entry) => {
          if (isUserEntry(entry) && !ending.has(messageOfEntry(entry) ?? "")) return true;
          if (shown(conversation, entry)) lastEntryId = idOf(entry.id);
          return false;
        });
        return { messageId: r.requestId as string, lastEntryId };
      }),
    );
    await recordEnded(conversation, ended);
  };

  const createConversation = async (sessionId: string): Promise<Conversation> => {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          ...(options.model ? { model: options.model } : {}),
          ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel as never } : {}),
        },
        init: (tx, id) => claimSession(tx, sessionId, id),
      },
      context,
    );
    await attach(sessionId, conversation);
    return conversation;
  };

  const serially = <A>(sessionId: string, work: () => Promise<A>): Promise<A> => {
    const previous = admissions.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(
      () => {},
      () => {},
    );
    admissions.set(sessionId, settled);
    void settled.then(() => {
      if (admissions.get(sessionId) === settled) admissions.delete(sessionId);
    });
    return next;
  };

  const notFound = (sessionId: string) => failure("not_found", `no session ${sessionId}`);

  const inFlight = async (): Promise<number> =>
    (await harness.inspect(context)).submissions.filter((s) => s.type === "input").length;

  /** The session's conversation, created now, or the one a concurrent create named it after while this one checked. */
  const claimOrFind = async (sessionId: string): Promise<Conversation> => {
    try {
      return await createConversation(sessionId);
    } catch (error) {
      // The one failure expected here: the creating commit found the id taken, and wrote nothing.
      if (!(error instanceof SessionExists)) throw error;
      const found = await conversationOf(sessionId);
      if (!found) throw new Error(`session ${sessionId} was taken, and is not found`);
      return found;
    }
  };

  /** A new session, empty or a fork; `conflict` when the id is taken, checked again by the commit that creates it. */
  const created = async (sessionId: string, fork: ForkSource | undefined): Promise<Result> => {
    if (await sessionOf(sessionId)) return failure("conflict", `session ${sessionId} exists`);
    try {
      if (!fork) {
        await createConversation(sessionId);
        return { ok: true };
      }
      const source = await conversationOf(fork.sessionId);
      if (!source) return notFound(fork.sessionId);
      const at = fork.entryId ?? (await newestPublished(source));
      if (at === undefined) {
        await createConversation(sessionId);
        return { ok: true };
      }
      if (!(await isPublished(source, at))) return failure("not_found", `no entry ${at} in session ${fork.sessionId}`);
      const forked = await source.fork(
        Number(at) as EntryId,
        { ownership: { kind: "ownerless" }, init: (tx, id) => claimSession(tx, sessionId, id) },
        context,
      );
      await attach(sessionId, forked);
      return { ok: true };
    } catch (error) {
      // The one failure expected here: the creating commit found the id taken, and wrote nothing.
      if (error instanceof SessionExists) return failure("conflict", error.message);
      throw error;
    }
  };

  const port: HarnessPort = {
    capabilities,

    submit: (sessionId, prompt: Prompt, { whenBusy, idempotencyKey, source }) =>
      serially(sessionId, async () => {
        const existing = await conversationOf(sessionId);
        const requestId = idempotencyKey === undefined ? `m:${crypto.randomUUID()}` : `k:${idempotencyKey}`;
        if (existing && idempotencyKey !== undefined) {
          const known = await findSubmission(existing, requestId);
          if (known) {
            const message = await statusOf(existing, known);
            if (message.status !== "done") await attach(sessionId, existing);
            return { ok: true as const, message, duplicate: true };
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
        const conversation = existing ?? (await claimOrFind(sessionId));
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
        // Owed before it is submitted, and followed, so its outcome is written and reported however fast it comes.
        await owe(conversation, requestId);
        await attach(sessionId, conversation);
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
          return {
            ok: true as const,
            message: await statusOf(conversation, record),
            duplicate: false,
          };
        } catch (error) {
          if (error instanceof ConversationBusy) {
            // Refused, so never admitted: it is owed nothing.
            await disown(conversation, requestId);
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
      return record ? statusOf(conversation, record) : undefined;
    },

    messageEntries: async (sessionId, messageId, after) => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      const record = await findSubmission(conversation, messageId);
      if (!record) return failure("not_found", `no message ${messageId}`);
      const message = await statusOf(conversation, record);
      if (after !== undefined && !(await isPublished(conversation, after))) {
        return failure("not_found", `no entry ${after}`);
      }
      const ended = message.status === "done";
      if (message.status === "queued" || message.entryId === undefined)
        return { ok: true as const, message, entries: [], ended };
      // From its own entry (or past the cursor) through where its work ended: a range of the log, never the whole.
      const from = Math.max(Number(message.entryId), after === undefined ? 0 : Number(after) + 1);
      const to =
        message.status === "done" && message.lastEntryId !== undefined ? Number(message.lastEntryId) : undefined;
      if (to !== undefined && from > to) return { ok: true as const, message, entries: [], ended };
      const { entries } = await publishedRange(
        conversation,
        { minEntryId: from, ...(to === undefined ? {} : { maxEntryId: to }), order: "ascending" },
        Number.POSITIVE_INFINITY,
      );
      return { ok: true as const, message, entries, ended };
    },

    cancelMessage: async (sessionId, messageId) => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      const record = await findSubmission(conversation, messageId);
      if (!record) return failure("not_found", `no message ${messageId}`);
      if (record.status === "done" || record.status === "unanswered") {
        return failure("conflict", `message ${messageId} is done`);
      }
      // Written first, so the settlement it causes reads as a cancel; never over an earlier stop's reason.
      await conversation.commit(async (tx) => {
        const stops = (await tx.doc(Stops, conversation.id)).byMessage;
        stops[messageId] ??= { by: "cancel", at: Date.now() };
      }, context);
      if (record.status === "queued") {
        const withdrawn = await (await harness.submission(record.id, context))?.abort(context);
        if (withdrawn === "aborted") return { ok: true };
        if (withdrawn !== "already_placed") return failure("conflict", `message ${messageId} is done`);
      }
      // Placed: it belongs to the conversation's run, which stopping is what cancels it, and every other message that
      // run took with it, alike (SPEC v1 §3.2).
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      const run = live?.run;
      if (!run?.inputs.includes(record.id)) return failure("conflict", `message ${messageId} is done`);
      const inputs = await Promise.all(run.inputs.map((id) => storage.submission(id, context)));
      await conversation.commit(async (tx) => {
        const stops = (await tx.doc(Stops, conversation.id)).byMessage;
        for (const input of inputs) {
          if (input?.requestId !== undefined) stops[input.requestId] ??= { by: "cancel", at: Date.now() };
        }
      }, context);
      await harness.abortTask(run.taskId, context);
      return { ok: true };
    },

    abort: async (sessionId): Promise<AbortResult> => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      // What abort stops: the run's inputs and the queue. A message taken by work that already stopped, its end not
      // written yet, has its outcome already, so it is not one abort ends.
      const [state, live] = await Promise.all([
        stateOf(sessionId, conversation),
        harness.snapshot(LiveDoc, conversation.id, context),
      ]);
      const running = await Promise.all((live?.run?.inputs ?? []).map((id) => storage.submission(id, context)));
      const taken = running.flatMap((r) => (r?.requestId === undefined ? [] : [r.requestId]));
      const queued = state.queued.map((q) => q.messageId);
      const compaction = (live?.compactions?.length ?? 0) > 0;
      if (taken.length + queued.length > 0) {
        await conversation.commit(async (tx) => {
          const stops = await tx.doc(Stops, conversation.id);
          for (const id of [...taken, ...queued]) stops.byMessage[id] ??= { by: "abort", at: Date.now() };
        }, context);
      }
      await conversation.abort(context);
      return { ok: true, stopped: { taken, queued, compaction } };
    },

    read: async (sessionId, page: Page): Promise<PortRead> => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      const cursor = "after" in page ? page.after : page.before;
      if (cursor !== null && !(await isPublished(conversation, cursor))) {
        return failure("not_found", `no entry ${cursor}`);
      }
      const state = await stateOf(sessionId, conversation);
      // One page of the log, read as a range from the cursor: `more` past its far end, and the cursor itself on the
      // near side (none without one, when it starts at the beginning or the end).
      if ("after" in page) {
        const range = { ...(cursor === null ? {} : { minEntryId: Number(cursor) + 1 }), order: "ascending" as const };
        const { entries, more } = await publishedRange(conversation, range, page.limit);
        const before = cursor !== null || (entries[0] !== undefined && entries[0].parentEntryId !== undefined);
        return { ok: true, state, entries, more: { before, after: more } };
      }
      const range = { ...(cursor === null ? {} : { maxEntryId: Number(cursor) - 1 }), order: "descending" as const };
      const { entries, more } = await publishedRange(conversation, range, page.limit);
      return { ok: true, state, entries, more: { before: more, after: cursor !== null } };
    },

    // A listener is followed for, from now on; once the last one leaves, an idle conversation is let go. A session that
    // does not exist yet is followed when its first message is submitted.
    watch: (sessionId, listener) => {
      const set = listeners.get(sessionId) ?? new Set();
      listeners.set(sessionId, set);
      set.add(listener);
      const following = (async () => {
        const conversation = await conversationOf(sessionId);
        if (conversation) await attach(sessionId, conversation);
      })();
      following.catch((error: unknown) =>
        log.error(`[fastagent] session ${sessionId}: following it failed: ${String(error)}`),
      );
      return () => {
        set.delete(listener);
        if (set.size > 0 || listeners.get(sessionId) !== set) return;
        listeners.delete(sessionId);
        void following
          .then(async () => {
            const known = await sessionOf(sessionId);
            if (known) await release(sessionId, known.conversationId as ConversationId);
          })
          .catch((error: unknown) =>
            log.error(`[fastagent] session ${sessionId}: letting it go failed: ${String(error)}`),
          );
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

    // Serialized with the session's admissions, and the commit that creates the conversation refuses a session id
    // another one holds: two creates, or a create and a first invoke, cannot both name a conversation after it.
    create: (sessionId, fork) => serially(sessionId, () => created(sessionId, fork)),

    rewind: async () => failure("unsupported", "this agent cannot rewind a session"),

    compact: async (sessionId, compactOptions = {}): Promise<Result> => {
      const conversation = await conversationOf(sessionId);
      if (!conversation) return notFound(sessionId);
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      if (live?.run) return failure("busy", "the session is working", { reason: "running" });
      let said = false;
      await scanEntries(conversation, { order: "descending" }, (record) => {
        said = shown(conversation, record)?.kind !== undefined && shown(conversation, record)?.kind !== "compaction";
        return said;
      });
      if (!said) {
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
      const { name, thinkingLevel } = settings;
      if (name !== undefined && name.trim() === "") return failure("invalid_request", "a session name cannot be empty");
      const models = await options.models();
      const spec = settings.model ?? (await conversation.agent(context)).model;
      const target =
        typeof spec === "string" ? spec : spec === undefined ? undefined : `${spec.provider}/${spec.modelId}`;
      const descriptor = models.find((m) => m.spec === target);
      if (settings.model !== undefined && !descriptor) {
        return failure("invalid_request", `unknown model "${settings.model}": models() lists the accepted models`);
      }
      if (thinkingLevel !== undefined && !descriptor?.thinkingLevels.includes(thinkingLevel)) {
        const accepted = descriptor ? descriptor.thinkingLevels.join(", ") || "none" : "none: the session has no model";
        return failure(
          "invalid_request",
          `thinking level "${thinkingLevel}" is not one ${target ?? "it"} takes (${accepted})`,
        );
      }
      const slash = settings.model?.indexOf("/") ?? -1;
      const model =
        settings.model === undefined
          ? undefined
          : { provider: settings.model.slice(0, slash), modelId: settings.model.slice(slash + 1) };
      // One commit: every field lands, or none does.
      await conversation.commit(async (tx) => {
        if (name !== undefined) {
          const own = (await tx.doc(Sessions)).byId[sessionId];
          if (own) own.name = name;
        }
        if (model || thinkingLevel !== undefined) {
          await configure(tx, conversation.id, {
            ...(model ? { model } : {}),
            ...(thinkingLevel !== undefined ? { thinkingLevel: thinkingLevel as never } : {}),
          });
        }
      }, context);
      return { ok: true };
    },

    delete: async () => failure("unsupported", "this agent cannot delete a session"),

    // The newest published entry's time: what changed last, read rather than written on every message.
    list: async () => {
      const index = (await harness.snapshot(Sessions, context))?.byId ?? {};
      const summaries = await Promise.all(
        Object.entries(index).map(async ([sessionId, own]) => {
          return {
            sessionId,
            ...(own.name === undefined ? {} : { name: own.name }),
            status: (await isBusy(own.conversationId as ConversationId)) ? ("running" as const) : ("idle" as const),
            createdAt: own.createdAt,
            updatedAt: await updatedAtOf(own.conversationId as ConversationId, own.createdAt),
          };
        }),
      );
      return summaries;
    },

    models: () => options.models(),
    commands: async () => (await options.commands?.()) ?? [],
  };

  // What needs following from the start: every conversation that owes a message an outcome. Following it makes good
  // what a previous process left: an end it did not record, a `done` it did not report.
  const index = (await harness.snapshot(Sessions, context))?.byId ?? {};
  const sessionOfConversation = new Map(
    Object.entries(index).map(([sessionId, own]) => [own.conversationId, sessionId]),
  );
  const owing = Object.keys((await harness.snapshot(Pending, context))?.byConversation ?? {});
  for (const conversationId of owing) {
    const sessionId = sessionOfConversation.get(Number(conversationId));
    if (sessionId === undefined)
      throw new Error(`conversation ${conversationId} owes messages, but no session names it`);
    const conversation = await conversationOf(sessionId);
    if (!conversation) continue;
    // Owed, but never admitted: the previous process stopped, or its submit failed, between owing and submitting it.
    for (const messageId of await pendingOf(conversation.id)) {
      if (await findSubmission(conversation, messageId)) continue;
      log.warn(`[fastagent] session ${sessionId}: message ${messageId} was never admitted; it is owed nothing`);
      await disown(conversation, messageId);
    }
    await attach(sessionId, conversation);
  }
  return port;
}
