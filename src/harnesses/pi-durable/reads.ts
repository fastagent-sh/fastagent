/**
 * What the Agent reads from pi-durable, as Effects: a session's conversation, its published entries in either
 * direction, a message as it is now, and the session. The operations and the event streams share them, so a Caller
 * reads the same facts through each.
 */
import type { Context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type Conversation,
  type ConversationId,
  type EntryQuery,
  type EntryRecord,
  type Harness,
  InboxDoc,
  LiveDoc,
  UsageDoc,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Entry, Message, Session } from "../../agent-api.ts";
import { type PortFailure, port } from "../../effect-port.ts";
import { isPublished, publishEntry, requestIdOf } from "./entries.ts";
import type { Ids } from "./ids.ts";
import type { Sessions } from "./sessions.ts";
import { type InputRecord, isInput, messageOf, sessionOf } from "./messages.ts";

const SCAN_PAGE = 100;

export type Reads = ReturnType<typeof durableReads>;

export function durableReads(harness: Harness, ids: Ids, sessions: Pick<Sessions, "has">, context: Context) {
  /** The session `sessionId` names: a conversation that is not a session (a subagent's) is no more reachable than none. */
  const conversation = (sessionId: string): Effect.Effect<Conversation | undefined, PortFailure> => {
    const id = ids.decode(sessionId) as ConversationId | undefined;
    return id === undefined || !sessions.has(id) ? Effect.undefined : port(() => harness.conversation(id, context));
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

  /** `records` as published, each user entry naming the message it took. */
  const publish = (records: readonly EntryRecord[]): Effect.Effect<Entry[], PortFailure> =>
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
      const messages = new Map(asked.map(({ record }, index) => [record.id as number, found[index]?.id]));
      return records.map((record) => publishEntry(record, ids, messages.get(record.id)));
    });

  const entryById = (id: number) => port(() => harness.commit((tx) => tx.entry(id as EntryRecord["id"]), context));

  /** The message `record` is; an answered one reads its answer entry, from `known` when it is there. */
  const message = (record: InputRecord, known: readonly EntryRecord[] = []): Effect.Effect<Message, PortFailure> =>
    Effect.gen(function* () {
      if (record.status !== "done") return messageOf(record, ids);
      const answer = known.find((entry) => entry.id === record.answer) ?? (yield* entryById(record.answer));
      return messageOf(record, ids, answer);
    });

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

  /**
   * The sessions as they are now, in one commit: each one's status, reply and settings of one moment, and a page of
   * them one turn on pi-durable's commit line, which every running session writes through too.
   */
  const sessionsOf = (conversations: readonly ConversationId[]): Effect.Effect<Session[], PortFailure> =>
    port(() =>
      harness.commit(async (tx) => {
        const read: Session[] = [];
        for (const id of conversations) {
          read.push(
            sessionOf(
              ids.encode(id),
              await tx.doc(LiveDoc, id),
              await tx.doc(UsageDoc, id),
              await tx.doc(AgentDoc, id),
            ),
          );
        }
        return read;
      }, context),
    );

  const session = (conversation: Pick<Conversation, "id">): Effect.Effect<Session, PortFailure> =>
    sessionsOf([conversation.id]).pipe(Effect.map((read) => read[0] as Session));

  return {
    conversation,
    history,
    published,
    publishedPages,
    visibleEntry,
    newestPublished,
    publish,
    message,
    submission,
    submissionByKey,
    inbox,
    session,
    sessionsOf,
  };
}
