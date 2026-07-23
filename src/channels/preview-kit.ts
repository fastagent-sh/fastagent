/**
 * Channel-neutral live-preview pieces shared by every messaging channel's preview renderer
 * (telegram/preview.ts, feishu/preview.ts, slack/preview.ts): the terminal-failure shape a channel hands to its
 * `onError`, the customer-facing default message for it, and the compact tool-arg summary and
 * humanized tool label for the live view. The preview LIFECYCLES stay per-platform (message edits vs streaming cards) — only
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

/** The customer-facing default: neutral, no leaked internals. Differentiate on retryability and always
 *  offer a next step (Slack agent-design: never leave the user with a dead-end "something went wrong").
 *  The non-retryable branch keeps the "something went wrong" phrase deliberately — it is neutral (we only
 *  know a boolean, never the specific limitation) and shared verbatim across channels. */
export function defaultErrorMessage(failed: ChannelFailure): string {
  return failed.retryable
    ? "⚠️ Temporary problem — please try again in a moment."
    : "⚠️ Sorry, something went wrong. Try rephrasing, or check I have access to what you need.";
}

/** Customer-facing live-preview line for an engine-internal retry backoff (the advisory `retrying`
 *  event): neutral, no leaked internals — the reason stays in operator logs. */
export const RETRY_NOTICE = "⏳ Temporary problem — retrying…";

/** Max length (code points) of a tool's arg preview in the live view. */
const TOOL_ARG_MAX = 48;

/** Max length (code points) of a humanized tool label. */
const TOOL_NAME_MAX = 80;

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

/**
 * A plain-language label for a tool call, following Slack's agent-design guidance to name what a tool
 * does rather than expose a raw identifier ("Create issue", not "create_issue"; "Github: create issue",
 * not "mcp__github__create_issue"). Deliberately generic and engine-neutral: it only reshapes the
 * identifier string — it never invents semantics and never exposes arguments. An `mcp__server__tool`
 * identifier becomes `server: tool`; any other identifier has its separators normalized to spaces and
 * its first letter capitalized.
 */
export function humanizeToolName(name: string): string {
  const normalize = (s: string): string =>
    s
      .replace(/[_\-.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const base = mcp ? `${normalize(mcp[1] ?? "")}: ${normalize(mcp[2] ?? "")}` : normalize(name);
  const label = base.trim() || name.trim() || "Tool";
  const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
  return truncateCodePointPrefix(capitalized, TOOL_NAME_MAX);
}
