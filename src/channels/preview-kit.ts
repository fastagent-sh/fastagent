/**
 * Channel-neutral live-preview pieces shared by every messaging channel's preview renderer
 * (telegram/preview.ts, feishu/preview.ts, slack/preview.ts): the turn-view REDUCER (the one
 * event → view-state machine every renderer consumes), its line renderers, the terminal-failure
 * shape a channel hands to its `onError`, and the customer-facing wording for it. The preview
 * LIFECYCLES stay per-platform — pumps, throttles, and delivery (message edits vs streaming cards
 * vs chat.update) are real platform differences — but everything platform-independent lives here,
 * so a new event type or a wording change lands in ONE place instead of one hunk per channel.
 */
import type { AgentEvent, Json } from "../agent.ts";
import { truncateCodePointPrefix, truncateCodePointSuffix } from "./text.ts";

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

/** The placeholder shown before any reasoning/tool/text arrives. */
export const THINKING_PLACEHOLDER = "💭 Thinking…";

/** One tool call's line in the live view. */
export interface ToolLine {
  label: string;
  status: "running" | "ok" | "error";
}

/**
 * The channel-neutral view STATE of one in-flight turn. Renderers own everything after this state:
 * when to reveal the young answer (age vs timer), how to format (HTML / card markdown / mrkdwn),
 * and how to deliver frames. Terminal events are deliberately NOT view state — completed/failed
 * resolve the preview into a final write, which is each platform's terminal-write policy.
 */
export interface TurnView {
  thinking: string;
  tools: ToolLine[];
  /** tool-call id → its line, for `tool_ended` status flips (bookkeeping; renderers read `tools`). */
  toolById: Map<string, ToolLine>;
  answer: string;
  /** Arrival time of the first non-empty answer delta; age-based reveal policies read it. */
  answerSince?: number;
  /** An advisory retry backoff is in progress (closed again by any subsequent progress event). */
  retrying: boolean;
}

export function createTurnView(): TurnView {
  return { thinking: "", tools: [], toolById: new Map(), answer: "", retrying: false };
}

/**
 * Apply one event to the view state. Returns true when the view changed (the caller repaints).
 * This is the ONE place the shared view rules live: tool labels are humanized with a compact arg
 * summary, and any progress event closes an open retry notice (a stale "retrying" line must never
 * outlive actual progress). Terminal events only close the notice — they are the caller's business.
 */
export function applyTurnEvent(view: TurnView, e: AgentEvent): boolean {
  const closedRetry = view.retrying && e.type !== "retrying";
  if (closedRetry) view.retrying = false;
  switch (e.type) {
    case "text":
      view.answer += e.delta;
      if (view.answerSince === undefined && view.answer.trim() !== "") view.answerSince = Date.now();
      return true;
    case "thinking":
      view.thinking += e.delta;
      return true;
    case "tool_started": {
      const arg = summarizeToolArgs(e.args);
      const name = humanizeToolName(e.name);
      const line: ToolLine = { label: arg ? `${name} ${arg}` : name, status: "running" };
      view.tools.push(line);
      view.toolById.set(e.id, line);
      return true;
    }
    case "tool_ended": {
      const line = view.toolById.get(e.id);
      if (line) line.status = e.isError ? "error" : "ok";
      return true;
    }
    case "retrying":
      view.retrying = true;
      return true;
    default:
      return closedRetry;
  }
}

const TOOL_MARK = { running: "…", ok: "✓", error: "✗" } as const;

/** The tool-activity block: one `🔧 label …/✓/✗` line per call, in call order. */
export function toolLines(view: TurnView): string {
  return view.tools.map((t) => `🔧 ${t.label} ${TOOL_MARK[t.status]}`).join("\n");
}

/** The reasoning peek: the most recent tail of the (growing) reasoning, one line, code-point safe.
 *  Process, not the answer — renderers show it live only, never in the persisted final message. */
export function thinkingLine(view: TurnView, maxTail: number): string {
  const t = view.thinking.replace(/\s+/g, " ").trim();
  return t === "" ? "" : `💭 ${truncateCodePointSuffix(t, maxTail)}`;
}

/** Compose body parts (thinking/tools/retry/answer) into one frame: skip empties, blank-line joins. */
export function composeTurnBody(parts: readonly string[]): string {
  return parts
    .filter((s) => s.trim() !== "")
    .join("\n\n")
    .trim();
}

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
