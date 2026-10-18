/**
 * pi's session entries as the records of a session's log (SPEC v1 §6): which entries are records at all, and each one
 * in the v1 vocabulary. Message entries become `user_message`, `assistant_message` and `tool_result` with the payload
 * a client renders; `LoopPort`'s message records become their own kinds; settings changes become `settings_changed`; any
 * other harness record keeps its pi type with an empty payload, present so parent chains and cursors stay intact.
 */
import { contentText } from "@earendil-works/pi-ai";
import {
  type SessionEntry as PiSessionEntry,
  type SessionManager,
  calculateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
} from "@earendil-works/pi-coding-agent";
import type { LogRecord, MessageMarker } from "../../loop-port.ts";
import type { Json, SessionState } from "../../protocol.ts";
import { entryImages } from "./entry-images.ts";
import { answerOutcome, answerThinking, endsRun } from "./messages.ts";
import { MESSAGE_MARKERS, isConversationMessage, isMessageMarker, isPlaneMarker } from "./session-markers.ts";

const MARKER_KINDS = new Map<string, MessageMarker>(
  Object.entries(MESSAGE_MARKERS).map(([kind, customType]) => [customType, kind as MessageMarker]),
);

/** Whether an entry is a record of the log at all: pi's prompt bookkeeping, labels and extension state are not. */
export function isRecord(entry: PiSessionEntry): boolean {
  if (entry.type === "message") return isConversationMessage(entry);
  if (entry.type === "custom") return isMessageMarker(entry);
  return entry.type !== "label" && entry.type !== "usage" && !isPlaneMarker(entry);
}

/** One pi entry, which {@link isRecord}, as a record of the log, under the nearest ancestor that is one. */
export function toRecord(entry: PiSessionEntry, parentEntryId: string | undefined): LogRecord {
  const base = { id: entry.id, ...(parentEntryId ? { parentEntryId } : {}), timestamp: Date.parse(entry.timestamp) };
  switch (entry.type) {
    case "message":
      return { ...base, ...messageRecord(entry.id, entry.message) };
    case "custom":
      return { ...base, kind: MARKER_KINDS.get(entry.customType) as string, data: (entry.data ?? {}) as Json };
    case "model_change":
      return { ...base, kind: "settings_changed", data: { model: `${entry.provider}/${entry.modelId}` } };
    case "thinking_level_change":
      return { ...base, kind: "settings_changed", data: { thinkingLevel: entry.thinkingLevel } };
    case "session_info":
      return { ...base, kind: "settings_changed", data: entry.name ? { name: entry.name } : {} };
    case "compaction":
      return {
        ...base,
        kind: "compaction",
        data: { summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId },
      };
    // Which entry the model no longer sees as written: `omitted` when it left the model context (pi's own abandoned
    // retry and overflow attempts, or an extension's edit), otherwise its content was replaced. Never the replacement.
    case "context_edit":
      return { ...base, kind: "context_edit", data: { targetId: entry.targetId, omitted: entry.replacement === null } };
    default:
      return { ...base, kind: entry.type, data: {} };
  }
}

type Message = Extract<PiSessionEntry, { type: "message" }>["message"];

function messageRecord(entryId: string, message: Message): Pick<LogRecord, "kind" | "data"> {
  switch (message.role) {
    case "user":
      return {
        kind: "user_message",
        data: { text: contentText(message.content, ""), ...entryImages(entryId, message) },
      };
    case "assistant": {
      // `args` is what `tool_started` carries live (pi emits the call's recorded `arguments` there), so a reopened
      // conversation shows the same call a watcher saw.
      const toolCalls = message.content.flatMap((block) =>
        block.type === "toolCall" ? [{ id: block.id, name: block.name, args: block.arguments as Json }] : [],
      );
      const thinking = answerThinking(message);
      const outcome = answerOutcome(message);
      return {
        kind: "assistant_message",
        data: {
          text: contentText(message.content, ""),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          // The same text the live `message_delta { channel: "thinking" }` added up to.
          ...(thinking !== undefined ? { thinking } : {}),
          ...(outcome ? { outcome } : {}),
        },
      };
    }
    case "toolResult":
      return {
        kind: "tool_result",
        data: {
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError ?? false,
          text: contentText(message.content, ""),
          ...entryImages(entryId, message),
          ...(endsRun(message) ? { terminate: true } : {}),
        },
      };
    default:
      // Not a conversation turn: {@link isRecord} keeps these out of the log.
      return { kind: `message:${(message as { role: string }).role}`, data: {} };
  }
}

/**
 * How full the session's context is, from the record rather than a live session (a served session exists only during
 * its run): the provider's own count on the newest answer pi counts as carrying usage (`getLastAssistantUsage`), plus
 * pi's estimate of what followed it, which after a finished run is nothing. Undefined before any answer carried usage.
 * The count is omitted, never guessed, once a compaction or a context edit follows that answer: it no longer describes
 * the context (pi's own rule).
 */
export function contextOf(
  path: PiSessionEntry[],
  record: SessionManager,
  window: number | undefined,
): SessionState["context"] {
  const usage = getLastAssistantUsage(path);
  if (!usage) return undefined;
  const known = window !== undefined && window > 0 ? { window } : {};
  let at = path.length - 1;
  while (at >= 0) {
    const entry = path[at];
    if (entry?.type === "message" && (entry.message as { usage?: unknown }).usage === usage) break;
    at--;
  }
  const answer = path[at];
  const stale = path.slice(at + 1).some((entry) => entry.type === "compaction" || entry.type === "context_edit");
  if (!answer || stale) return Object.keys(known).length > 0 ? known : undefined;
  let trailing = 0;
  let after = false;
  for (const { sourceEntry, messages } of record.buildSessionProjection().entries) {
    if (after) for (const message of messages) trailing += estimateTokens(message);
    if (sourceEntry.id === answer.id) after = true;
  }
  return { tokens: calculateContextTokens(usage) + trailing, ...known };
}
