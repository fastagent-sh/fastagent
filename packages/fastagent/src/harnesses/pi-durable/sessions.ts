/**
 * Which conversations are sessions, and each one's latest activity, kept in memory as a cache of the
 * storage: read once when the Agent opens, then moved forward by every commit, so `sessions.list` orders without
 * reading the storage and every operation asks the same question `sessions.list` answers.
 *
 * pi-durable mints every record's id from one counter that grows across reopen (`Storage.mintId`), so a session's
 * latest activity is the newest of its own ids: its creation, its newest message, its newest entry. No clock is
 * needed. A conversation a task owns (a subagent's) is the harness's own work, not a session.
 */
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, ConversationRecord, EntryRecord, Harness, Storage } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { type PromiseFailure, fromPromise } from "../../promise-bridge.ts";
import { SessionMetaDoc, type SessionMetaState } from "./messages.ts";

const SCAN_PAGE = 500;
const CONTEXT_SCAN_LIMIT = 50;

export const isSession = (record: ConversationRecord): boolean => record.owner === undefined;

interface SessionActivity {
  conversationId: ConversationId;
  activity: number;
}

export interface Sessions {
  has(id: ConversationId): boolean;
  /** Most recently active first. */
  byActivity(): SessionActivity[];
  /** Latest assistant context tokens in the active branch, or undefined before an answer or right after compaction. */
  contextTokens(id: ConversationId): number | undefined;
  /** Seed context tokens for a newly created fork from its active history. */
  setContextTokens(id: ConversationId, tokens: number | undefined): void;
}

function assistantContextTokens(record: EntryRecord): number | undefined {
  if (record.kind !== "pi.assistant") return undefined;
  const model = record.model?.[0] as AssistantMessage | undefined;
  if (model?.role !== "assistant" || model.stopReason === "error") return undefined;
  const { input, output, cacheRead, cacheWrite } = model.usage;
  const total = input + output + cacheRead + cacheWrite;
  return total > 0 ? total : undefined;
}

function hasContextBoundary(recordsDescending: readonly EntryRecord[]): boolean {
  for (const record of recordsDescending) {
    if (record.kind === "pi.compaction" || record.kind === "pi.reset") return true;
    if (assistantContextTokens(record) !== undefined) return true;
  }
  return false;
}

export function latestContextTokens(recordsDescending: readonly EntryRecord[]): number | undefined {
  for (const record of recordsDescending) {
    if (record.kind === "pi.compaction" || record.kind === "pi.reset") return undefined;
    const tokens = assistantContextTokens(record);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

const conversations = (storage: Storage, context: Context) =>
  Stream.paginate(undefined as Parameters<Storage["scanConversations"]>[2], (cursor) =>
    fromPromise(() => storage.scanConversations({}, SCAN_PAGE, cursor, context)).pipe(
      Effect.map((page) => [[page.items], Option.fromUndefinedOr(page.next)] as const),
    ),
  ).pipe(Stream.flattenIterable);

/** What the storage holds before the cache follows commits: latest activity id and active-branch context tokens. */
const storedSessionState = (harness: Harness, storage: Storage, context: Context, conversation: ConversationRecord) =>
  Effect.all(
    [
      fromPromise(() =>
        storage.scanEntries(
          { conversationId: conversation.id, order: "descending" },
          CONTEXT_SCAN_LIMIT,
          undefined,
          context,
        ),
      ),
      fromPromise(() =>
        storage.scanSubmissions({ conversationId: conversation.id, order: "descending" }, 1, undefined, context),
      ),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap(([entries, submissions]) => {
      // An entry a fork shares is older than the fork, so the fork-aware entry scan cannot overstate activity.
      const activity = Math.max(conversation.id, entries.items[0]?.id ?? 0, submissions.items[0]?.id ?? 0);
      if (hasContextBoundary(entries.items) || conversation.parent === undefined) {
        return Effect.succeed({ activity, contextTokens: latestContextTokens(entries.items) });
      }
      // A fork with no own assistant/compaction entries inherits active context from its parent chain.
      return fromPromise(async () => {
        const conv = await harness.conversation(conversation.id, context);
        if (conv === undefined) return undefined;
        const inherited = await conv.entries({ order: "descending" }, CONTEXT_SCAN_LIMIT, undefined, context);
        return latestContextTokens(inherited.items);
      }).pipe(Effect.map((contextTokens) => ({ activity, contextTokens })));
    }),
  );

/** The cache, following commits until the scope closes. */
export const trackSessions = (
  harness: Harness,
  storage: Storage,
  context: Context,
): Effect.Effect<Sessions, PromiseFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const sessions = new Set<ConversationId>();
    const deleted = new Set<ConversationId>();
    const newest = new Map<ConversationId, number>();
    const contextBySession = new Map<ConversationId, number>();
    const contextUpdatedAt = new Map<ConversationId, number>();
    const touch = (id: ConversationId, value: number) => {
      if (value > (newest.get(id) ?? 0)) newest.set(id, value);
    };
    const recordEntryContext = (record: EntryRecord) => {
      const id = record.conversationId;
      if (record.id <= (contextUpdatedAt.get(id) ?? 0)) return;
      if (record.kind === "pi.compaction" || record.kind === "pi.reset") {
        contextUpdatedAt.set(id, record.id);
        contextBySession.delete(id);
        return;
      }
      const tokens = assistantContextTokens(record);
      if (tokens !== undefined) {
        contextUpdatedAt.set(id, record.id);
        contextBySession.set(id, tokens);
      }
    };
    // Observed before the scan, so a commit while it reads is not lost: either reports the newest id, and the
    // larger stands. A change's conversation may be created in the same commit, so membership is not checked here.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        harness.observeCommits({
          advance: ({ changes }) => {
            for (const change of changes) {
              if (change.type === "conversation") {
                if (isSession(change.value) && !deleted.has(change.value.id)) sessions.add(change.value.id);
                touch(change.value.id, change.value.id);
              } else if (change.type === "entry") {
                if (!deleted.has(change.value.conversationId)) {
                  touch(change.value.conversationId, change.value.id);
                  recordEntryContext(change.value);
                }
              } else if (change.type === "submission") {
                if (!deleted.has(change.value.conversationId)) {
                  touch(change.value.conversationId, change.value.id);
                }
              } else if (
                change.type === "document" &&
                change.kind === "change" &&
                change.record.kind === SessionMetaDoc.definition.kind &&
                change.conversationId !== undefined
              ) {
                const meta = change.value as SessionMetaState;
                if (meta.deleted) {
                  deleted.add(change.conversationId);
                  sessions.delete(change.conversationId);
                  contextBySession.delete(change.conversationId);
                }
              }
            }
          },
          end: () => {},
        }),
      ),
      (observation) => Effect.sync(() => observation.detach()),
    );
    yield* conversations(storage, context).pipe(
      Stream.filter(isSession),
      Stream.runForEach((conversation) =>
        Effect.all(
          [
            storedSessionState(harness, storage, context, conversation),
            fromPromise(() => harness.snapshot(SessionMetaDoc, conversation.id, context)),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.tap(([stored, meta]) =>
            Effect.sync(() => {
              if (meta?.deleted || deleted.has(conversation.id)) {
                deleted.add(conversation.id);
                sessions.delete(conversation.id);
                return;
              }
              sessions.add(conversation.id);
              touch(conversation.id, stored.activity);
              if (stored.contextTokens !== undefined && !contextUpdatedAt.has(conversation.id)) {
                contextBySession.set(conversation.id, stored.contextTokens);
              }
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
      contextTokens: (id) => contextBySession.get(id),
      setContextTokens: (id, tokens) => {
        if (tokens === undefined) contextBySession.delete(id);
        else contextBySession.set(id, tokens);
      },
    };
  });
