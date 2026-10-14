/**
 * The text of a run's agent messages as a renderer shows it: the live deltas, and what an `assistant_message` entry
 * says that no delta did. Deltas are live only (SPEC v1 §6), so a run that ended before its stream subscribed, or one
 * the stream fell behind on, has its text in the entry alone.
 */
import type { SessionEvent } from "./protocol.ts";

/** Feed it a run's events; it answers the text each one adds. */
export function runText(runId: () => string | undefined): (event: SessionEvent) => string {
  let streamed = "";
  return (event) => {
    if (event.type === "message_delta") {
      if (event.channel !== "text" || event.runId !== runId()) return "";
      streamed += event.delta;
      return event.delta;
    }
    if (event.type !== "entry" || event.entry.kind !== "assistant_message" || event.entry.runId !== runId()) return "";
    const text = String((event.entry.data as { text?: unknown }).text ?? "");
    const missing = text.startsWith(streamed) ? text.slice(streamed.length) : "";
    streamed = "";
    return missing;
  };
}
