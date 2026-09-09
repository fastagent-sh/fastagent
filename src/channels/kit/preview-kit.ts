/**
 * Channel-neutral live-preview pieces shared by every messaging channel's preview renderer (telegram/preview.ts,
 * feishu/preview.ts, slack/preview.ts).
 */
import type { AgentEvent, Json } from "../../agent.ts";
import { truncateCodePointPrefix, truncateCodePointSuffix } from "./text.ts";

/** A terminal failure, as a channel hands it to its `onError`. */
export interface ChannelFailure {
  details: string;
  retryable: boolean;
  /** The engine's failure code, when it set one. */
  code?: string;
}

/** The customer-facing default: neutral, no leaked internals. */
export function defaultErrorMessage(failed: ChannelFailure): string {
  return failed.retryable
    ? "⚠️ Temporary problem — please try again in a moment."
    : "⚠️ Sorry, something went wrong. Try rephrasing, or check I have access to what you need.";
}

/**
 * Customer-facing live-preview line for an engine-internal retry backoff (the advisory `retrying` event): neutral, no
 * leaked internals — the reason stays in operator logs.
 */
export const RETRY_NOTICE = "⏳ Temporary problem — retrying…";

/** The placeholder shown before any reasoning/tool/text arrives. */
export const THINKING_PLACEHOLDER = "💭 Thinking…";

/** One tool call's line in the live view. */
interface ToolLine {
  label: string;
  status: "running" | "ok" | "error";
}

/** The channel-neutral view STATE of one in-flight turn. */
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

export function applyTurnEvent(view: TurnView, e: AgentEvent, now = Date.now()): boolean {
  const closedRetry = view.retrying && e.type !== "retrying";
  if (closedRetry) view.retrying = false;
  switch (e.type) {
    case "text":
      view.answer += e.delta;
      if (view.answerSince === undefined && view.answer.trim() !== "") view.answerSince = now;
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

/** The reasoning peek: the most recent tail of the (growing) reasoning, one line, code-point safe. */
export function thinkingLine(view: TurnView, maxTail: number): string {
  const t = view.thinking.replace(/\s+/g, " ").trim();
  return t === "" ? "" : `💭 ${truncateCodePointSuffix(t, maxTail)}`;
}

/**
 * The shared answer-reveal policy: the answer stays hidden until its first delta has aged one throttle window (`ageMs`
 * — each platform passes its own pacing constant).
 */
export function revealedAnswer(view: TurnView, ageMs: number, now = Date.now()): string {
  if (view.answer.trim() === "" || view.answerSince === undefined) return "";
  return now - view.answerSince >= ageMs ? view.answer : "";
}

/** Compose body parts (thinking/tools/retry/answer) into one frame: skip empties, blank-line joins. */
export function composeTurnBody(parts: readonly string[]): string {
  return parts
    .filter((s) => s.trim() !== "")
    .join("\n\n")
    .trim();
}

/** Max length (code points) of a tool's arg preview. */
const TOOL_ARG_MAX = 48;

/** Max length (code points) of a humanized tool label. */
const TOOL_NAME_MAX = 80;

/**
 * One-line, truncated at code-point boundaries: collapse whitespace so a multi-line command/arg stays on one line, and
 * never tear a surrogate pair mid-emoji.
 */
function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return truncateCodePointPrefix(one, TOOL_ARG_MAX);
}

/**
 * A compact, human-readable preview of a tool call's args so the live view reads `🔧 read AGENTS.md` rather than just
 * `🔧 read`.
 */
export function summarizeToolArgs(args: Json): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return clip(String(args));
  const values = Object.values(args);
  const primary = values.find((v) => typeof v === "string" || typeof v === "number");
  if (primary !== undefined) return clip(String(primary));
  return values.length > 0 ? clip(JSON.stringify(args)) : "";
}

/**
 * A plain-language label for a tool call, following Slack's agent-design guidance to name what a tool does rather than
 * expose a raw identifier ("Create issue", not "create_issue"; "Github: create issue", not
 * "mcp__github__create_issue").
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
