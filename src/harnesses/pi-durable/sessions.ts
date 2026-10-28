/**
 * Which conversations are sessions, and each one's latest activity (agent-api.md §4), kept in memory as a cache of the
 * storage: read once when the Agent opens, then moved forward by every commit, so `sessions.list` orders without
 * reading the storage and every operation asks the same question `sessions.list` answers.
 *
 * pi-durable mints every record's id from one counter that grows across reopen (`Storage.mintId`), so a session's
 * latest activity is the newest of its own ids: its creation, its newest message, its newest entry. No clock is
 * needed. A conversation a task owns (a subagent's) is the harness's own work, not a session.
 */
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, ConversationRecord, Harness, Storage } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { type PortFailure, port } from "../../effect-port.ts";

const SCAN_PAGE = 500;

export const isSession = (record: ConversationRecord): boolean => record.owner === undefined;

interface SessionActivity {
  conversationId: ConversationId;
  activity: number;
}

export interface Sessions {
  has(id: ConversationId): boolean;
  /** Most recently active first. */
  byActivity(): SessionActivity[];
}

const conversations = (storage: Storage, context: Context) =>
  Stream.paginate(undefined as Parameters<Storage["scanConversations"]>[2], (cursor) =>
    port(() => storage.scanConversations({}, SCAN_PAGE, cursor, context)).pipe(
      Effect.map((page) => [[page.items], Option.fromUndefinedOr(page.next)] as const),
    ),
  ).pipe(Stream.flattenIterable);

/** What the storage holds before the cache follows commits: the newest entry an existing session wrote, and message. */
const storedActivity = (storage: Storage, context: Context, conversation: ConversationRecord) =>
  Effect.all(
    [
      port(() => storage.scanEntries({ conversationId: conversation.id, order: "descending" }, 1, undefined, context)),
      port(() =>
        storage.scanSubmissions({ conversationId: conversation.id, order: "descending" }, 1, undefined, context),
      ),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    // An entry a fork shares is older than the fork, so the fork-aware entry scan cannot overstate it.
    Effect.map(([entries, submissions]) =>
      Math.max(conversation.id, entries.items[0]?.id ?? 0, submissions.items[0]?.id ?? 0),
    ),
  );

/** The cache, following commits until the scope closes. */
export const trackSessions = (
  harness: Harness,
  storage: Storage,
  context: Context,
): Effect.Effect<Sessions, PortFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const sessions = new Set<ConversationId>();
    const newest = new Map<ConversationId, number>();
    const touch = (id: ConversationId, value: number) => {
      if (value > (newest.get(id) ?? 0)) newest.set(id, value);
    };
    // Subscribed before the scan, so a commit while it reads is not lost: either reports the newest id, and the
    // larger stands. A change's conversation may be created in the same commit, so membership is not checked here.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        harness.subscribeCommits(({ changes }) => {
          for (const change of changes) {
            if (change.type === "conversation") {
              if (isSession(change.value)) sessions.add(change.value.id);
              touch(change.value.id, change.value.id);
            } else if (change.type === "entry" || change.type === "submission") {
              touch(change.value.conversationId, change.value.id);
            }
          }
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    yield* conversations(storage, context).pipe(
      Stream.filter(isSession),
      Stream.runForEach((conversation) =>
        storedActivity(storage, context, conversation).pipe(
          Effect.tap((activity) =>
            Effect.sync(() => {
              sessions.add(conversation.id);
              touch(conversation.id, activity);
            }),
          ),
        ),
      ),
    );
    return {
      has: (id) => sessions.has(id),
      byActivity: () =>
        [...sessions]
          .map((conversationId) => ({ conversationId, activity: newest.get(conversationId) ?? conversationId }))
          .sort((a, b) => b.activity - a.activity),
    };
  });
