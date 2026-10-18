/**
 * pi's session events as a piece of work's live events (SPEC v1 §6): its text and thinking as they are written, the tool calls
 * it starts, a running call's status line, and retries.
 *
 * Stateful only for `tool_progress`, the one event that is a status rather than a fact: an outer call's status line is
 * sent when it changes, and a call that call makes, at any depth, is its status. A call's result is not live: it is
 * the `tool_result` entry.
 */
import { stripVTControlCharacters } from "node:util";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Json, LiveEvent } from "../../protocol.ts";
import { streamsThinkingDelta } from "./messages.ts";

/** One piece of work's projection: feed it every event pi emits, in order. */
export function liveEvents(): (event: AgentSessionEvent) => LiveEvent | undefined {
  /** Each nested call's outer call: the one the work announced with `tool_started`. */
  const outerOf = new Map<string, string>();
  /** The status line each outer call last reported. */
  const shown = new Map<string, string>();
  const progress = (toolCallId: string, text: string | undefined): LiveEvent | undefined => {
    if (text === undefined || shown.get(toolCallId) === text) return undefined;
    shown.set(toolCallId, text);
    return { type: "tool_progress", toolCallId, text };
  };
  return (event) => {
    switch (event.type) {
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type !== "text_delta" && update.type !== "thinking_delta") return undefined;
        // An empty delta must not spend the silent window in which a provider retry is safe. A redacted block's
        // placeholder is not reasoning, and its entry will not carry it either (messages.ts answerThinking).
        if (update.delta === "" || (update.type === "thinking_delta" && !streamsThinkingDelta(update))) {
          return undefined;
        }
        return {
          type: "message_delta",
          channel: update.type === "text_delta" ? "text" : "thinking",
          delta: update.delta,
        };
      }
      case "tool_execution_start": {
        const args = event.args as Json;
        if (!event.parentToolCallId) {
          return { type: "tool_started", toolCallId: event.toolCallId, name: event.toolName, args };
        }
        const outer = outerOf.get(event.parentToolCallId) ?? event.parentToolCallId;
        outerOf.set(event.toolCallId, outer);
        return progress(outer, callLine(event.toolName, args));
      }
      case "tool_execution_update": {
        // A nested call's own output is not its caller's status; the nested call starting is (above).
        const content = (event.partialResult as { content?: unknown }).content;
        if (event.parentToolCallId || !Array.isArray(content)) return undefined;
        return progress(event.toolCallId, lastLine(contentText(content, "\n")));
      }
      case "auto_retry_start":
      case "summarization_retry_scheduled":
        return {
          type: "retry_scheduled",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          reason: event.errorMessage,
        };
      default:
        return undefined;
    }
  };
}

/**
 * The line a terminal shows last: control sequences removed, and a bare `\r`, a progress bar redrawing in place, ends a
 * line like `\n` does. Undefined when there is no visible text yet (a shell that has printed nothing).
 */
function lastLine(text: string): string | undefined {
  const lines = stripVTControlCharacters(text).split(/\r\n|\r|\n/);
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
