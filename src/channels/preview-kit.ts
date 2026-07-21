/**
 * Channel-neutral live-preview pieces shared by every messaging channel's preview renderer
 * (telegram/preview.ts, feishu/preview.ts): the terminal-failure shape a channel hands to its
 * `onError`, the customer-facing default message for it, and the compact tool-arg summary for the
 * live view. The preview LIFECYCLES stay per-platform (message edits vs streaming cards) — only
 * these platform-independent policies live here, so the customer-facing wording cannot drift
 * between channels.
 */
import type { Json } from "../agent.ts";
import { truncateCodePointPrefix } from "./text.ts";

/** A terminal failure, as a channel hands it to its `onError`. */
export interface ChannelFailure {
  details: string;
  retryable: boolean;
}

/** The customer-facing default: neutral, no leaked internals; differentiate only on whether to retry. */
export function defaultErrorMessage(failed: ChannelFailure): string {
  return failed.retryable ? "⚠️ Temporary problem — please try again." : "⚠️ Sorry, something went wrong.";
}

/** Max length (code points) of a tool's arg preview in the live view. */
const TOOL_ARG_MAX = 48;

/** One-line, truncated at code-point boundaries: collapse whitespace so a multi-line command/arg
 *  stays on one line, and never tear a surrogate pair mid-emoji. */
function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return truncateCodePointPrefix(one, TOOL_ARG_MAX);
}

/**
 * A compact, human-readable preview of a tool call's args so the live view reads `🔧 read AGENTS.md`
 * rather than just `🔧 read`. Generic (a channel knows no tool schemas): show the salient value — the
 * first primitive field, conventionally the subject (path / command / query / url) — else compact JSON.
 */
export function summarizeToolArgs(args: Json): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return clip(String(args));
  const values = Object.values(args);
  const primary = values.find((v) => typeof v === "string" || typeof v === "number");
  if (primary !== undefined) return clip(String(primary));
  return values.length > 0 ? clip(JSON.stringify(args)) : "";
}
