/**
 * What the Agent reads from pi-durable, as Effects: a session's conversation, its published entries in either
 * direction, a message's status and end, and the session's state. The operations and `resume` share them, so a
 * Caller reads the same facts through each.
 */
import type { Context } from "@earendil-works/chord/context";
import {
  type Conversation,
  type ConversationId,
  type EntryQuery,
  type EntryRecord,
  type Harness,
  InboxDoc,
  LiveDoc,
  type Submission,
  UsageDoc,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { DoneMessage, Entry, MessageStatus, SessionState } from "../../agent-api.ts";
import { type PortFailure, port } from "../../effect-port.ts";
import { isPublished, publishEntry, requestIdOf } from "./entries.ts";
import type { Ids } from "./ids.ts";
import {
  type EndedRecord,
  type InputRecord,
  doneMessage,
  idempotencyKeyOf,
  isInput,
  messageStatus,
  queuedInputs,
  sessionState,
} from "./messages.ts";

const SCAN_PAGE = 100;

export type Reads = ReturnType<typeof durableReads>;

export function durableReads(harness: Harness, ids: Ids, context: Context) {
  const conversation = (sessionId: string): Effect.Effect<Conversation | undefined, PortFailure> => {
    const id = ids.decode(sessionId);
    return id === undefined ? Effect.undefined : port(() => harness.conversation(id as ConversationId, context));
  };

  /** The conversation's history in `query`'s range and order, its own entries and those a fork shares, a page at a time. */
  const pages = (conversation: Conversation, query: Omit<EntryQuery, "conversationId">) =>
    Stream.paginate(undefined as Parameters<Conversation["entries"]>[2], (cursor) =>
      port(() => conversation.entries(query, SCAN_PAGE, cursor, context)).pipe(
        Effect.map((page) => [[page.items], Option.fromUndefinedOr(page.next)] as const),
      ),
    );

  const history = (conversation: Conversation, query: Omit<EntryQuery, "conversationId">) =>
    pages(conversation, query).pipe(Stream.flattenIterable);

  const published = (conversation: Conversation, query: Omit<EntryQuery, "conversationId">) =>
    history(conversation, query).pipe(Stream.filter(isPublished));

  /** The published entries in `query`'s range and order, a scanned page at a time (some may be empty). */
  const publishedPages = (conversation: Conversation, query: Omit<EntryQuery, "conversationId">) =>
    pages(conversation, query).pipe(Stream.map((page) => page.filter(isPublished)));

  /** An entry the session can see, published or not: a cursor may name either. */
  const visibleEntry = (conversation: Conversation, entryId: string) => {
    const id = ids.decode(entryId);
    if (id === undefined) return Effect.undefined;
    const bound = id as EntryRecord["id"];
    return port(() => conversation.entries({ minEntryId: bound, maxEntryId: bound }, 1, undefined, context)).pipe(
      Effect.map((page) => page.items[0]),
    );
  };

  const newestPublished = (conversation: Conversation, atOrBefore: number | undefined) =>
    published(conversation, {
      order: "descending",
      ...(atOrBefore === undefined ? {} : { maxEntryId: atOrBefore as EntryRecord["id"] }),
    }).pipe(
      Stream.take(1),
      Stream.runHead,
      Effect.map((head) => Option.getOrUndefined(head)?.id),
    );

  /** `records`, published oldest first, each the parent of the next; `parent` is the first one's. */
  const publish = (records: readonly EntryRecord[], parent: number | undefined): Effect.Effect<Entry[], PortFailure> =>
    Effect.gen(function* () {
      const asked = records.flatMap((record) => {
        const requestId = requestIdOf(record);
        return requestId === undefined ? [] : [{ record, requestId }];
      });
      const found =
        asked.length === 0
          ? []
          : yield* port(() =>
              harness.commit(async (tx) => {
                const records = [];
                for (const { record, requestId } of asked) {
                  records.push(await tx.submissionByRequest(record.conversationId, requestId));
                }
                return records;
              }, context),
            );
      const messages = new Map(asked.map(({ record }, index) => [record.id as number, found[index]]));
      let previous = parent;
      return records.map((record) => {
        const submission = messages.get(record.id);
        const key = idempotencyKeyOf(submission?.requestId);
        const entry = publishEntry(record, {
          ids,
          parent: previous,
          ...(submission === undefined
            ? {}
            : { message: { messageId: submission.id, ...(key === undefined ? {} : { idempotencyKey: key }) } }),
        });
        previous = record.id;
        return entry;
      });
    });

  const entryById = (id: number) => port(() => harness.commit((tx) => tx.entry(id as EntryRecord["id"]), context));

  const done = (record: EndedRecord, known: readonly EntryRecord[] = []): Effect.Effect<DoneMessage, PortFailure> =>
    Effect.gen(function* () {
      if (record.status !== "done") return doneMessage(record, ids, undefined);
      const answer = known.find((entry) => entry.id === record.answer) ?? (yield* entryById(record.answer));
      return doneMessage(record, ids, answer);
    });

  const status = (record: InputRecord): Effect.Effect<MessageStatus, PortFailure> => {
    switch (record.status) {
      case "queued":
        return port(() => harness.snapshot(InboxDoc, record.conversationId, context)).pipe(
          Effect.flatMap((inbox) =>
            queuedInputs(inbox).includes(record.id)
              ? Effect.succeed(messageStatus(record, ids, { ...(inbox === undefined ? {} : { inbox }) }))
              : // Taken or withdrawn between the two reads: a race no test can time, so this branch is untested.
                port(() => harness.submission(record.id, context)).pipe(
                  Effect.flatMap((handle) => port(() => (handle as Submission).status(context))),
                  Effect.flatMap((current) => status(current as InputRecord)),
                ),
          ),
        );
      case "placed":
        return Effect.succeed(messageStatus(record, ids, {}));
      default:
        return done(record);
    }
  };

  const submission = (messageId: string) => {
    const id = ids.decode(messageId);
    if (id === undefined) return Effect.undefined;
    return port(() => harness.submission(id as InputRecord["id"], context)).pipe(
      Effect.flatMap((handle) => (handle === undefined ? Effect.undefined : port(() => handle.status(context)))),
      Effect.map((record) => (isInput(record) ? record : undefined)),
    );
  };

  const submissionByKey = (conversation: Conversation, requestId: string) =>
    port(() => harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context)).pipe(
      Effect.map((record) => (isInput(record) ? record : undefined)),
    );

  const inbox = (conversation: Conversation) => port(() => harness.snapshot(InboxDoc, conversation.id, context));

  /** One commit's reads, so a message moving from the inbox into the run is in `queued` or in `taken`, never neither. */
  const state = (conversation: Conversation): Effect.Effect<SessionState, PortFailure> =>
    port(() =>
      harness.commit(
        async (tx) =>
          sessionState(
            await tx.doc(LiveDoc, conversation.id),
            await tx.doc(InboxDoc, conversation.id),
            await tx.doc(UsageDoc, conversation.id),
            ids,
          ),
        context,
      ),
    );

  return {
    conversation,
    history,
    published,
    publishedPages,
    visibleEntry,
    newestPublished,
    publish,
    done,
    status,
    submission,
    submissionByKey,
    inbox,
    state,
  };
}
