/**
 * Channel-neutral live-preview pieces shared by every messaging channel's preview renderer
 * (telegram/preview.ts, feishu/preview.ts, slack/preview.ts): the turn-view REDUCER (the one
 * event → view-state machine every renderer consumes), its line renderers, the terminal-failure
 * shape a channel hands to its `onError`, the customer-facing wording for it, and the serialized
 * single-writer pump. DELIVERY stays per-platform — message edits vs streaming cards vs chat.update,
 * pacing constants, reveal timing, and terminal-write policies are real platform differences — but
 * everything platform-independent lives here, so a new event type or a wording change lands in ONE
 * place instead of one hunk per channel.
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
interface ToolLine {
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

/**
 * The shared answer-reveal policy: the answer stays hidden until its first delta has aged one
 * throttle window (`ageMs` — each platform passes its own pacing constant). The pump's leading-edge
 * flush would otherwise turn the very first content delta (often a lone character or unbalanced
 * markup) into its own frame — the short-reply flicker (placeholder → "O" → "OK."). Aging is
 * anchored at delta ARRIVAL (`answerSince`, set by the reducer) so an in-flight write can't skew the
 * clock, and there is deliberately NO timer at the boundary: a young answer surfaces on the next
 * content-driven pass, so a turn completing within the window delivers the final answer only.
 */
export function revealedAnswer(view: TurnView, ageMs: number): string {
  if (view.answer.trim() === "" || view.answerSince === undefined) return "";
  return Date.now() - view.answerSince >= ageMs ? view.answer : "";
}

/** Compose body parts (thinking/tools/retry/answer) into one frame: skip empties, blank-line joins. */
export function composeTurnBody(parts: readonly string[]): string {
  return parts
    .filter((s) => s.trim() !== "")
    .join("\n\n")
    .trim();
}

/**
 * The serialized live-preview writer shared by the edit/snapshot renderers (telegram, feishu).
 * Events mark the view dirty; the pump repaints to the LATEST view with at most ONE write in
 * flight, paced by `throttleMs`. One-in-flight is the whole point: concurrent writes can land out
 * of order — an older frame over a newer one is the "shows 3-4 steps, blanks, re-fills" flicker —
 * so a single writer keeps frames monotonic (and makes feishu's strictly-increasing card `sequence`
 * correct by construction). NOT used by slack-classic: its pacing lives inside the flush (the 3s
 * chat.update rate slot), not at the frame boundary.
 */
export interface PreviewPump {
  /** Mark the view dirty and ensure the single writer runs (an in-flight write picks the new state
   *  up on its next loop). Synchronous — callers never await a network write. */
  touch(): void;
  /** Stop the pump, cut an in-flight throttle short, and await any in-flight write — so the
   *  caller's terminal write is strictly the LAST one (no stale frame landing after the answer). */
  finish(): Promise<void>;
}

export function createPreviewPump(opts: {
  /** Write the LATEST view. Best-effort — the terminal write is authoritative. */
  flush: () => Promise<void>;
  /** Pace + coalesce a burst into one write; finish() interrupts a throttle in progress. */
  throttleMs: number;
  /** Called for the FIRST failing flush only (the pump keeps running): a never-rendering preview
   *  must be diagnosable, not silent — and not a log flood. */
  onError: (error: unknown) => void;
}): PreviewPump {
  let dirty = false;
  let pumping = false;
  let stopped = false;
  let errored = false;
  let pumpDone: Promise<void> | undefined;
  let wakeThrottle: (() => void) | undefined; // set while mid-throttle; finish() cuts it short
  const runPump = async (): Promise<void> => {
    pumping = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await opts.flush();
        } catch (error) {
          if (!errored) {
            errored = true;
            opts.onError(error);
          }
        }
        if (dirty && !stopped) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, opts.throttleMs);
            wakeThrottle = () => {
              clearTimeout(t);
              resolve();
            };
          });
          wakeThrottle = undefined;
        }
      }
    } finally {
      pumping = false;
    }
  };
  return {
    touch() {
      dirty = true;
      if (!pumping) pumpDone = runPump();
    },
    async finish() {
      stopped = true;
      wakeThrottle?.();
      await pumpDone?.catch(() => {});
    },
  };
}

/** Max length (code points) of a tool's arg preview in the live view. */
const TOOL_ARG_MAX = 48;

/** Max length (code points) of a humanized tool label. */
const TOOL_NAME_MAX = 80;

/** One-line, truncated at code-point boundaries: collapse whitespace so a multi-line command/arg
 *  stays on one line, and never tear a surrogate pair mid-emoji. */
function clip(s: string, maxPoints: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return truncateCodePointPrefix(one, maxPoints);
}

/**
 * A compact, human-readable preview of a tool call's args so the live view reads `🔧 read AGENTS.md`
 * rather than just `🔧 read`. Generic (a channel knows no tool schemas): show the salient value — the
 * first primitive field, conventionally the subject (path / command / query / url) — else compact JSON.
 * Messaging previews use the compact default; a transport with more room may pass a larger bound.
 */
export function summarizeToolArgs(args: Json, maxPoints = TOOL_ARG_MAX): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return clip(String(args), maxPoints);
  const values = Object.values(args);
  const primary = values.find((v) => typeof v === "string" || typeof v === "number");
  if (primary !== undefined) return clip(String(primary), maxPoints);
  return values.length > 0 ? clip(JSON.stringify(args), maxPoints) : "";
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
