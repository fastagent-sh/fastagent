/**
 * `sessions.events` (SPEC.md §6.1) over pi-durable's view of one conversation: the entries asked for, a `state`
 * snapshot, then what each commit changes. The view is observed synchronously, one revision per commit, so the
 * replay ends at the first revision's newest entry and the live part, diffed from one revision to the next, starts
 * after it. Every revision is kept: a message that is placed and answered between two reads still gets its `done`.
 */
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type Conversation,
  type ConversationDocToken,
  type ConversationView,
  type EntryRecord,
  type Harness,
  type JsonObject,
  InboxDoc,
  LiveDoc,
  type LiveState,
  type SubmissionId,
  UsageDoc,
  type WatchEnd,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AgentError, type Entry, type Json, type SessionEvent, agentError, errorData } from "../../agent-api.ts";
import { type PortFailure, port, portError } from "../../effect-port.ts";
import { isPublished, replyText, thinkingOf } from "./entries.ts";
import type { Ids } from "./ids.ts";
import { type EndedRecord, hasEnded, isInput, sessionOf } from "./messages.ts";
import type { Reads } from "./reads.ts";

/** Revisions a Caller may leave unread before its stream ends: pi-durable keeps no bound for a synchronous observer. */
const UNREAD_REVISIONS = 1000;

type Pending = { view: ConversationView } | { end: WatchEnd } | { behind: true };
type Blocks = AssistantMessage["content"];

export interface EventsOptions {
  harness: Harness;
  reads: Reads;
  ids: Ids;
  context: Context;
  failureOf: (error: unknown) => AgentError;
  /** The retry budget a `retrying` reports. */
  maxRetries: number;
}

/**
 * The session's events after the entry `after` names (`"start"`: every entry; absent: none). An unknown session or
 * entry, and a storage that fails before the snapshot, fail the stream; a failure after it is a `stream_error`.
 */
export function sessionEvents(
  { harness, reads, ids, context, failureOf, maxRetries }: EventsOptions,
  sessionId: string,
  afterEntry: string | undefined,
): Stream.Stream<SessionEvent, AgentError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const conversation = yield* reads.conversation(sessionId);
      if (conversation === undefined) return yield* agentError("not_found", `No session ${sessionId}`);
      let after: number | undefined;
      if (afterEntry === "start") after = 0;
      else if (afterEntry !== undefined) {
        const entry = yield* reads.visibleEntry(conversation, afterEntry);
        if (entry === undefined) {
          return yield* agentError("not_found", `No entry ${afterEntry} in session ${sessionId}`);
        }
        after = entry.id;
      }
      const pending = yield* Effect.acquireRelease(Queue.unbounded<Pending>(), Queue.shutdown);
      let behind = false;
      const observation = yield* Effect.acquireRelease(
        port(() =>
          harness.observeConversation(
            conversation.id,
            {
              advance: (call) => {
                if (behind || call.kind !== "value") return;
                behind = Queue.sizeUnsafe(pending) >= UNREAD_REVISIONS;
                Queue.offerUnsafe(pending, behind ? { behind } : { view: call.value });
              },
              end: (end) => {
                Queue.offerUnsafe(pending, { end });
              },
            },
            context,
          ),
        ),
        (attached) => Effect.sync(() => attached.detach()),
      );

      const snapshot = observation.value;
      const newest = newestEntry(snapshot);
      const live = liveTranslator(harness, reads, conversation, context, maxRetries, snapshot);
      const replay =
        after === undefined || newest === undefined || after >= newest
          ? Stream.empty
          : replayed(reads, conversation, after, newest);
      const present = Stream.succeed<SessionEvent>({
        type: "state",
        session: sessionOf(
          ids.encode(conversation.id),
          docOf(snapshot, LiveDoc),
          docOf(snapshot, UsageDoc),
          docOf(snapshot, AgentDoc),
        ),
      });
      const events = Stream.fromQueue(pending).pipe(
        Stream.mapEffect((next) => ("view" in next ? live.translate(next.view) : Effect.succeed([ended(next)]))),
        Stream.flattenIterable,
      );
      return Stream.concat(Stream.concat(replay, present), events).pipe(
        Stream.catchCause((cause) => Stream.succeed(streamError(failureOf(portError(cause))))),
        Stream.takeUntil((event) => event.type === "stream_error"),
      );
    }).pipe(
      Effect.catchCause((cause) => {
        const error = portError(cause);
        return Effect.fail(error instanceof AgentError ? error : failureOf(error));
      }),
    ),
  );
}

const streamError = (error: AgentError): SessionEvent => ({ type: "stream_error", error: errorData(error) });

function ended(end: { end: WatchEnd } | { behind: true }): SessionEvent {
  if ("behind" in end) {
    return streamError(agentError("unavailable", "This stream fell behind the session; continue after its last entry"));
  }
  switch (end.end.kind) {
    case "failed":
      return streamError(agentError("unavailable", `The agent stopped serving this session: ${String(end.end.error)}`));
    case "listener_error":
      return streamError(agentError("internal", `Following the session failed: ${end.end.error.message}`));
    default:
      return streamError(agentError("unavailable", `The agent stopped serving this session (${end.end.kind})`));
  }
}

/** The newest entry a view has seen: its window's last, or the one before an empty window. */
function newestEntry(view: ConversationView): number | undefined {
  return view.entries.at(-1)?.id ?? view.before;
}

function replayed(
  reads: Reads,
  conversation: Conversation,
  after: number,
  through: number,
): Stream.Stream<SessionEvent, PortFailure> {
  return reads
    .publishedPages(conversation, {
      order: "ascending",
      minEntryId: (after + 1) as EntryRecord["id"],
      maxEntryId: through as EntryRecord["id"],
    })
    .pipe(Stream.mapEffect(reads.publish), Stream.flattenIterable, Stream.map(entryEvent));
}

const entryEvent = (entry: Entry): SessionEvent => ({ type: "entry", entry });

/** A built-in document of the view, as its token types it. */
const docOf = <T extends JsonObject>(view: ConversationView, token: ConversationDocToken<T>): T | undefined =>
  view.docs[token.definition.kind] as T | undefined;

const liveOf = (view: ConversationView) => docOf(view, LiveDoc);

/** The inputs a view has not ended: queued in its inbox, or taken by its run. */
function unendedInputs(view: ConversationView): Set<SubmissionId> {
  const inbox = docOf(view, InboxDoc);
  return new Set([
    ...(inbox?.items ?? []).flatMap((item) => (item.mode === "write" ? [] : [item.id])),
    ...(liveOf(view)?.run?.inputs ?? []),
  ]);
}

/** A reply's text and thinking as a Caller has been shown them. */
const shownOf = (content: Blocks) => ({ text: replyText({ content }), thinking: thinkingOf({ content }) ?? "" });

/**
 * What one revision of the view adds for a Caller, against the revision before it: the reply's deltas, the tool calls
 * that start and their status lines, retries, the entries appended, and a `done` for each message that ended, before
 * the next message's entry.
 */
function liveTranslator(
  harness: Harness,
  reads: Reads,
  conversation: Conversation,
  context: Context,
  maxRetries: number,
  snapshot: ConversationView,
) {
  const first = liveOf(snapshot);
  let newest = newestEntry(snapshot);
  let shown = shownOf((first?.generation?.message?.content as Blocks | undefined) ?? []);
  let retry = retryKey(first);
  let unended = unendedInputs(snapshot);
  const toolArgs = new Map<string, Json>();
  const started = new Set((first?.tools ?? []).filter((slot) => slot.status !== "pending").map((slot) => slot.callId));
  const lines = new Map((first?.tools ?? []).flatMap((slot) => lineOf(slot.callId, slot.output)));
  const nested = new Map((first?.nestedTools ?? []).map((slot) => [slot.callId, slot.parentCallId]));
  const outermost = (callId: string): string => {
    const parent = nested.get(callId);
    return parent === undefined ? callId : outermost(parent);
  };
  const learnToolArgs = (records: readonly EntryRecord[]) => {
    for (const record of records) {
      const model = record.model?.[0];
      if (model?.role !== "assistant") continue;
      for (const block of model.content) if (block.type === "toolCall") toolArgs.set(block.id, block.arguments as Json);
    }
  };
  learnToolArgs(snapshot.entries);

  const deltas = (content: Blocks): SessionEvent[] => {
    const now = shownOf(content);
    const added = (channel: "text" | "thinking"): SessionEvent[] => {
      if (now[channel].length <= shown[channel].length) return [];
      const from = now[channel].startsWith(shown[channel]) ? shown[channel].length : 0;
      return [{ type: "delta", channel, text: now[channel].slice(from) }];
    };
    const events = [...added("thinking"), ...added("text")];
    shown = now;
    return events;
  };
  const progress = (toolCallId: string, text: string | undefined): SessionEvent[] => {
    if (text === undefined || lines.get(toolCallId) === text) return [];
    lines.set(toolCallId, text);
    return [{ type: "tool_progress", toolCallId, text }];
  };
  const toolEvents = (live: LiveState | undefined): SessionEvent[] => {
    const events: SessionEvent[] = [];
    const tools = live?.tools ?? [];
    for (const slot of tools) {
      if (slot.status === "pending") continue;
      if (!started.has(slot.callId)) {
        started.add(slot.callId);
        const args = toolArgs.get(slot.callId);
        if (args === undefined) throw new Error(`tool call ${slot.callId} started with no answer that made it`);
        events.push({ type: "tool_started", toolCallId: slot.callId, name: slot.name, args });
      }
      if (slot.status === "running") events.push(...progress(slot.callId, lastLine(slot.output ?? "")));
    }
    const calls = live?.nestedTools ?? [];
    for (const slot of calls) {
      if (nested.has(slot.callId)) continue;
      nested.set(slot.callId, slot.parentCallId);
      events.push(...progress(outermost(slot.callId), callLine(slot.name, slot.arguments)));
    }
    const current = new Set([...tools, ...calls].map((slot) => slot.callId));
    for (const callId of [...started, ...lines.keys(), ...nested.keys()]) {
      if (current.has(callId)) continue;
      started.delete(callId);
      lines.delete(callId);
      nested.delete(callId);
    }
    return events;
  };
  /** The entries `view` appended: its window's new ones, after those a window that moved past them left out. */
  const appended = (view: ConversationView): Effect.Effect<EntryRecord[], PortFailure> =>
    Effect.gen(function* () {
      const fresh = view.entries.filter((entry) => newest === undefined || entry.id > newest);
      const skipped =
        view.before === undefined || (newest !== undefined && view.before <= newest)
          ? []
          : yield* reads
              .history(conversation, {
                order: "ascending",
                minEntryId: ((newest ?? 0) + 1) as EntryRecord["id"],
                maxEntryId: view.before,
              })
              .pipe(Stream.runCollect);
      const records = [...skipped, ...fresh];
      newest = records.at(-1)?.id ?? newest;
      return records;
    });
  const endedMessages = (view: ConversationView, known: readonly EntryRecord[]) => {
    const now = unendedInputs(view);
    const gone = [...unended].filter((id) => !now.has(id));
    unended = now;
    return Effect.forEach(gone, (id) =>
      port(async () => (await harness.submission(id, context))?.status(context)).pipe(
        Effect.flatMap((record) =>
          isInput(record) && hasEnded(record) ? reads.message(record as EndedRecord, known) : Effect.undefined,
        ),
      ),
    ).pipe(Effect.map((messages) => messages.flatMap((message) => (message === undefined ? [] : [message]))));
  };

  return {
    translate: (view: ConversationView): Effect.Effect<SessionEvent[], PortFailure> =>
      Effect.gen(function* () {
        const records = yield* appended(view);
        learnToolArgs(records);
        const live = liveOf(view);
        const before: SessionEvent[] = [];
        const nextRetry = retryKey(live);
        if (nextRetry !== undefined && nextRetry !== retry && live?.generation?.retry !== undefined) {
          shown = shownOf([]);
          before.push({
            type: "retrying",
            attempt: live.generation.attempt,
            maxAttempts: maxRetries,
            delayMs: Math.max(0, live.generation.retry.at - Date.now()),
            reason: live.generation.retry.error,
          });
        }
        retry = nextRetry;
        const reply = live?.generation?.message?.content as Blocks | undefined;
        if (reply !== undefined) before.push(...deltas(reply));
        if (reply === undefined || records.some((record) => record.model?.[0]?.role === "assistant")) {
          shown = shownOf([]);
        }
        before.push(...toolEvents(live));

        const published = yield* reads.publish(records.filter(isPublished));
        const dones = yield* endedMessages(view, records);
        // pi-durable places the next queued message in the commit that ends a run: its message's `done` goes first.
        const next = published.findIndex((entry) => entry.kind === "user");
        const at = next === -1 ? published.length : next;
        return [
          ...before,
          ...published.slice(0, at).map(entryEvent),
          ...dones.map((message): SessionEvent => ({ type: "done", message })),
          ...published.slice(at).map(entryEvent),
        ];
      }),
  };
}

/** Which retry a generation waits for, so each is reported once. */
function retryKey(live: LiveState | undefined): string | undefined {
  const generation = live?.generation;
  return generation?.retry === undefined ? undefined : `${generation.attempt}:${generation.retry.at}`;
}

function lineOf(callId: string, output: string | undefined): [string, string][] {
  const line = lastLine(output ?? "");
  return line === undefined ? [] : [[callId, line]];
}

/** The last line with text, a running tool's status. pi-durable's output already has no control characters. */
function lastLine(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line;
  }
  return undefined;
}

/** A nested call as its caller's status: the tool and its first plain argument, on one line (`weather London`). */
function callLine(name: string, args: Json): string {
  const first =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? Object.values(args).find((value) => typeof value === "string" || typeof value === "number")
      : undefined;
  return first === undefined ? name : `${name} ${String(first).replace(/\s+/g, " ").trim()}`.trim();
}
