/**
 * `sessions.events` (SPEC.md §6.1) over pi-durable's event stream of one conversation: the entries asked for, a
 * `state` snapshot, then what each commit adds. pi-durable captures its snapshot and the registration for later
 * commits atomically, so the replay ends at the snapshot's newest entry and the live part starts after it.
 */
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  type Conversation,
  type EntryRecord,
  type Harness,
  type MessageChange,
  type SnapshotEvent,
  type WatchEnd,
  watchEvents,
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

type Batch = { events: readonly AgentEvent[] } | { end: WatchEnd };
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
      const batches = yield* Effect.acquireRelease(Queue.bounded<Batch>(1), Queue.shutdown);
      const watch = yield* Effect.acquireRelease(
        port(() => watchEvents(harness, conversation.id, context)),
        (stream) => Effect.promise(() => stream.stop()),
      );
      // Taking one batch at a time keeps pi-durable's own bound on what a slow Caller leaves undelivered.
      watch.start((events) => Effect.runPromiseExit(Queue.offer(batches, { events })).then(() => undefined));
      void watch.closed.then((end) => Effect.runPromiseExit(Queue.offer(batches, { end })));

      const { snapshot } = watch;
      const newest = snapshot.entries.reduce<number | undefined>(
        (max, entry) => (max === undefined || entry.id > max ? entry.id : max),
        undefined,
      );
      const live = liveTranslator(reads, maxRetries, snapshot);
      const replay =
        after === undefined || newest === undefined || after >= newest
          ? Stream.empty
          : replayed(reads, conversation, after, newest);
      const present = Stream.succeed<SessionEvent>({
        type: "state",
        session: sessionOf(ids.encode(conversation.id), snapshot, snapshot.usage, snapshot.agent),
      });
      const events = Stream.fromQueue(batches).pipe(
        Stream.mapEffect((batch) =>
          "end" in batch ? Effect.succeed([ended(batch.end)]) : live.translate(batch.events),
        ),
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

function ended(end: WatchEnd): SessionEvent {
  switch (end.reason) {
    case "session_failed":
      return streamError(agentError("unavailable", `The agent's storage failed: ${String(end.error)}`));
    case "listener_error":
      return streamError(agentError("internal", `Following the session failed: ${end.error.message}`));
    default:
      return streamError(agentError("unavailable", `The agent stopped serving this session (${end.reason})`));
  }
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

/**
 * What one commit's events add for a Caller: the reply's deltas, the tool calls that start and their status lines,
 * retries, the published entries, and a `done` for each message that ended, before the next message's entry.
 */
function liveTranslator(reads: Reads, maxRetries: number, snapshot: SnapshotEvent) {
  let reply: Blocks = [...((snapshot.generation?.message?.content as Blocks | undefined) ?? [])];
  let shown = { text: replyText({ content: reply }), thinking: thinkingOf({ content: reply }) ?? "" };
  const outputs = new Map(snapshot.tools.map((slot) => [slot.callId, slot.output ?? ""]));
  const lines = new Map<string, string>();
  const outer = new Map(snapshot.nestedTools.map((slot) => [slot.callId, slot.parentCallId]));
  const outermost = (callId: string): string => {
    const parent = outer.get(callId);
    return parent === undefined ? callId : outermost(parent);
  };

  const restart = () => {
    reply = [];
    shown = { text: "", thinking: "" };
  };
  const deltas = (): SessionEvent[] => {
    const now = { text: replyText({ content: reply }), thinking: thinkingOf({ content: reply }) ?? "" };
    const added = (channel: "text" | "thinking"): SessionEvent[] =>
      now[channel].length > shown[channel].length && now[channel].startsWith(shown[channel])
        ? [{ type: "delta", channel, text: now[channel].slice(shown[channel].length) }]
        : [];
    const events = [...added("thinking"), ...added("text")];
    shown = now;
    return events;
  };
  const apply = (changes: readonly MessageChange[]) => {
    for (const change of changes) {
      switch (change.type) {
        case "message":
          reply = [...change.message.content];
          break;
        case "text_start":
        case "thinking_start":
        case "toolcall_start":
        case "block":
          reply[change.contentIndex] = change.block;
          break;
        case "text_delta": {
          const block = reply[change.contentIndex];
          if (block?.type === "text") reply[change.contentIndex] = { ...block, text: block.text + change.delta };
          break;
        }
        case "thinking_delta": {
          const block = reply[change.contentIndex];
          if (block?.type === "thinking") {
            reply[change.contentIndex] = { ...block, thinking: block.thinking + change.delta };
          }
          break;
        }
        case "toolcall_delta":
          break;
      }
    }
  };
  const progress = (toolCallId: string, text: string | undefined): SessionEvent[] => {
    if (text === undefined || lines.get(toolCallId) === text) return [];
    lines.set(toolCallId, text);
    return [{ type: "tool_progress", toolCallId, text }];
  };

  return {
    translate: (events: readonly AgentEvent[]): Effect.Effect<SessionEvent[], PortFailure> =>
      Effect.gen(function* () {
        const before: SessionEvent[] = [];
        const entries: EntryRecord[] = [];
        const settled: EndedRecord[] = [];
        for (const [index, event] of events.entries()) {
          switch (event.type) {
            case "snapshot":
              return [
                streamError(
                  agentError("unavailable", "This stream fell behind the session; continue after its last entry"),
                ),
              ];
            case "message_start":
              // An entry's own start comes right before its end; any other is a new reply being written.
              if (events[index + 1]?.type !== "message_end" && event.message.role === "assistant") {
                reply = [...event.message.content];
                shown = { text: "", thinking: "" };
                before.push(...deltas());
              }
              break;
            case "message_update":
              apply(event.changes);
              before.push(...deltas());
              break;
            case "message_end":
            case "entry_appended":
              entries.push(event.entry);
              if (event.entry.model?.[0]?.role === "assistant") restart();
              break;
            case "tool_execution_start":
              if (event.parentToolCallId === undefined) {
                before.push({
                  type: "tool_started",
                  toolCallId: event.toolCallId,
                  name: event.toolName,
                  args: event.args as Json,
                });
              } else {
                outer.set(event.toolCallId, event.parentToolCallId);
                before.push(...progress(outermost(event.toolCallId), callLine(event.toolName, event.args)));
              }
              break;
            case "tool_execution_update": {
              if (event.parentToolCallId !== undefined || event.output === undefined) break;
              const output = event.output;
              const current = outputs.get(event.toolCallId) ?? "";
              const next = "set" in output ? output.set : current.slice(output.trimStart ?? 0) + (output.append ?? "");
              outputs.set(event.toolCallId, next);
              before.push(...progress(event.toolCallId, lastLine(next)));
              break;
            }
            case "auto_retry_start":
              restart();
              before.push({
                type: "retrying",
                attempt: event.attempt,
                maxAttempts: maxRetries,
                delayMs: Math.max(0, event.at - Date.now()),
                reason: event.errorMessage,
              });
              break;
            case "tool_execution_end":
              outputs.delete(event.toolCallId);
              lines.delete(event.toolCallId);
              outer.delete(event.toolCallId);
              break;
            case "submission":
              if (isInput(event.record) && hasEnded(event.record)) settled.push(event.record);
              break;
          }
        }
        const published = yield* reads.publish(entries.filter(isPublished));
        const dones = yield* Effect.forEach(settled, (record) => reads.message(record, entries));
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
