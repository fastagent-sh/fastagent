/**
 * Every session the Agent holds, with its latest activity (agent-api.md §5's `listSessions`). pi-durable mints every
 * record's id from one counter, greater than every id before it across reopen (`Storage.mintId`), so the newest of a
 * session's own ids (its creation, its newest message, its newest entry) is its latest activity: no clock and no index.
 * A conversation a task owns (a subagent's) is the harness's own work, not a session.
 */
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, ConversationRecord, Storage } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { type PortFailure, port } from "../../effect-port.ts";

const SCAN_PAGE = 500;

export interface SessionActivity {
  conversationId: ConversationId;
  activity: number;
}

const conversations = (storage: Storage, context: Context) =>
  Stream.paginate(undefined as Parameters<Storage["scanConversations"]>[2], (cursor) =>
    port(() => storage.scanConversations({}, SCAN_PAGE, cursor, context)).pipe(
      Effect.map((page) => [[page.items], Option.fromUndefinedOr(page.next)] as const),
    ),
  ).pipe(Stream.flattenIterable);

/** The newest of the conversation's own ids; an entry a fork shares is older than the fork itself. */
const activityOf = (storage: Storage, context: Context, conversation: ConversationRecord) =>
  Effect.all([
    port(() => storage.scanEntries({ conversationId: conversation.id, order: "descending" }, 1, undefined, context)),
    port(() =>
      storage.scanSubmissions({ conversationId: conversation.id, order: "descending" }, 1, undefined, context),
    ),
  ]).pipe(
    Effect.map(([entries, submissions]) =>
      Math.max(conversation.id, entries.items[0]?.id ?? 0, submissions.items[0]?.id ?? 0),
    ),
  );

/** Every session with its latest activity, most recent first. */
export const sessionsByActivity = (storage: Storage, context: Context): Effect.Effect<SessionActivity[], PortFailure> =>
  conversations(storage, context).pipe(
    Stream.filter((conversation) => conversation.owner === undefined),
    Stream.mapEffect((conversation) =>
      activityOf(storage, context, conversation).pipe(
        Effect.map((activity) => ({ conversationId: conversation.id, activity })),
      ),
    ),
    Stream.runCollect,
    Effect.map((sessions) => [...sessions].sort((a, b) => b.activity - a.activity)),
  );
