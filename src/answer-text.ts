/**
 * The text of the agent's messages in one message's stream, as a renderer shows it: the live deltas, and what an
 * `assistant_message` entry says that no delta did. Deltas are live only (SPEC.md §6), so work that ended before its
 * stream subscribed, or that the stream fell behind on, has its text in the entry alone.
 */
import type { SessionEvent } from "./agent-api.ts";

/** Feed it a message's stream; it answers the text each event adds. */
export function answerText(): (event: SessionEvent) => string {
  let streamed = "";
  return (event) => {
    if (event.type === "message_delta") {
      if (event.channel !== "text") return "";
      streamed += event.delta;
      return event.delta;
    }
    if (event.type !== "entry" || event.entry.kind !== "assistant_message") return "";
    const text = String((event.entry.data as { text?: unknown }).text ?? "");
    const missing = text.startsWith(streamed) ? text.slice(streamed.length) : "";
    streamed = "";
    return missing;
  };
}
