/**
 * The text of the agent's replies in one message's stream, as a renderer shows it: the live deltas, and what an
 * `assistant` entry says that no delta did. Deltas are live only (agent-api.md §6.1), so work that ended before its
 * stream subscribed, or that the stream fell behind on, has its text in the entry alone.
 */
import type { SessionEvent } from "./agent-api.ts";

/** Feed it a message's stream; it answers the text each event adds. */
export function answerText(): (event: SessionEvent) => string {
  let streamed = "";
  return (event) => {
    if (event.type === "delta") {
      if (event.channel !== "text") return "";
      streamed += event.text;
      return event.text;
    }
    if (event.type !== "entry" || event.entry.kind !== "assistant") return "";
    const text = String((event.entry.data as { text?: unknown }).text ?? "");
    const missing = text.startsWith(streamed) ? text.slice(streamed.length) : "";
    streamed = "";
    return missing;
  };
}
