/**
 * Rendering adapters from FastAgent Agent API objects (`Entry`, `RemoteViewState`, `Usage`) to Pi TUI
 * components, matching Pi's native visual language across 80-col and wide terminals.
 */
import type { AssistantMessage, StopReason, Usage as PiUsage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  type EntryRenderOptions,
  type ReadonlyFooterDataProvider,
  type Theme,
  UserMessageComponent,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Markdown, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContentPart, ContextUsage, Entry, Json, Tokens, Usage } from "@fastagent-sh/client";
import type { ActiveTool, LiveReply, RemoteViewState } from "./controller.ts";

export interface RemoteEntryPayload {
  remoteName: string;
  sessionId: string;
  entry: Entry;
  toolArgs?: Json;
}

export interface RemoteBannerPayload {
  remoteName: string;
  agentName: string;
  sessionId: string;
  title?: string;
  model?: string;
  thinkingLevel?: string;
  starters?: readonly string[];
}

interface AssistantEntryData {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ id: string; name: string; args: Json }>;
  stop?: "max_tokens" | "failed" | "aborted";
  error?: string;
  usage?: Tokens;
}

interface UserEntryData {
  content?: ContentPart[];
  messageId?: string;
}

interface ToolResultEntryData {
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  content?: ContentPart[];
  details?: Json;
}

interface CompactionEntryData {
  summary?: string;
}

const MAX_EXPANDED_TOOL_LINES = 120;

const ZERO_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function formatCompactTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function toPiUsage(tokens: Tokens | undefined): PiUsage {
  if (!tokens) return ZERO_USAGE;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  const cacheWrite = tokens.cacheWriteTokens ?? 0;
  return {
    input: tokens.inputTokens,
    output: tokens.outputTokens,
    cacheRead,
    cacheWrite,
    totalTokens: tokens.inputTokens + tokens.outputTokens + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens.cost ?? 0 },
  };
}

function toStopReason(stop: AssistantEntryData["stop"], hasTools: boolean): StopReason {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "failed":
      return "error";
    case "aborted":
      return "aborted";
    default:
      return hasTools ? "toolUse" : "stop";
  }
}

function assistantEntryToPiMessage(entry: Entry, provider = "fastagent", model = "remote"): AssistantMessage {
  const data = (entry.data ?? {}) as AssistantEntryData;
  const content: AssistantMessage["content"] = [];
  if (data.thinking) {
    content.push({ type: "thinking", thinking: data.thinking });
  }
  if (data.text) {
    content.push({ type: "text", text: data.text });
  }
  const hasTools = Boolean(data.toolCalls && data.toolCalls.length > 0);
  return {
    role: "assistant",
    content,
    api: "fastagent-remote",
    provider,
    model,
    usage: toPiUsage(data.usage),
    stopReason: toStopReason(data.stop, hasTools),
    ...(data.error ? { errorMessage: data.error } : {}),
    timestamp: entry.timestamp,
  };
}

function formatArgsSummary(args: Json, maxLen = 72): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args.length > maxLen ? `${args.slice(0, maxLen - 1)}…` : args;
  if (typeof args === "object" && !Array.isArray(args)) {
    const pairs = Object.entries(args)
      .slice(0, 3)
      .map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        const clipped = val && val.length > 36 ? `${val.slice(0, 35)}…` : val;
        return `${k}=${clipped}`;
      });
    const joined = pairs.join(" ");
    return joined.length > maxLen ? `${joined.slice(0, maxLen - 1)}…` : joined;
  }
  const raw = JSON.stringify(args);
  return raw.length > maxLen ? `${raw.slice(0, maxLen - 1)}…` : raw;
}

function formatContentParts(parts: readonly ContentPart[] | undefined): string {
  if (!parts || parts.length === 0) return "";
  return parts.map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`)).join("\n");
}

export function formatUsageSummary(usage: Usage | undefined): string {
  if (!usage) return "";
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  for (const tokens of Object.values(usage.models)) {
    input += tokens.inputTokens;
    output += tokens.outputTokens;
    cacheRead += tokens.cacheReadTokens ?? 0;
    cacheWrite += tokens.cacheWriteTokens ?? 0;
    cost += tokens.cost ?? 0;
  }
  for (const tokens of Object.values(usage.tools)) {
    cost += tokens.cost ?? 0;
  }
  const parts: string[] = [];
  if (input > 0) parts.push(`↑${formatCompactTokens(input)}`);
  if (output > 0) parts.push(`↓${formatCompactTokens(output)}`);
  if (cacheRead > 0) parts.push(`R${formatCompactTokens(cacheRead)}`);
  if (cacheWrite > 0) parts.push(`W${formatCompactTokens(cacheWrite)}`);
  if (cost > 0) parts.push(`$${cost.toFixed(3)}`);
  return parts.join(" ");
}

export function formatContextSummary(contextUsage: ContextUsage | undefined, theme?: Theme): string {
  if (!contextUsage) return "";
  if (contextUsage.contextWindow && contextUsage.contextWindow > 0) {
    const pct = (contextUsage.tokens / contextUsage.contextWindow) * 100;
    const text = `${pct.toFixed(1)}%/${formatCompactTokens(contextUsage.contextWindow)}`;
    if (!theme) return text;
    if (pct > 90) return theme.fg("error", text);
    if (pct > 70) return theme.fg("warning", text);
    return text;
  }
  return `${formatCompactTokens(contextUsage.tokens)} ctx`;
}

export function shortId(id: string): string {
  if (id.length <= 12) return id;
  const dot = id.lastIndexOf(".");
  if (dot > 0 && dot < id.length - 1) {
    return `${id.slice(0, 4)}…${id.slice(dot)}`;
  }
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export function formatRelativeTime(timestamp: number | undefined, now = Date.now()): string {
  if (timestamp === undefined) return "";
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function renderRemoteBanner(payload: RemoteBannerPayload, theme: Theme): Component {
  const box = new Box(1, 0, (line) => theme.bg("customMessageBg", line));
  const agentPart = payload.agentName && payload.agentName !== payload.remoteName ? ` (${payload.agentName})` : "";
  const titlePart = payload.title ? ` • ${payload.title}` : "";
  const header = `${theme.fg("accent", "☁")} ${theme.bold(payload.remoteName)}${theme.fg("dim", agentPart)}${titlePart} ${theme.fg("dim", `[${shortId(payload.sessionId)}]`)}`;
  const lines = [header];
  const metaParts: string[] = [];
  if (payload.model) metaParts.push(payload.model);
  if (payload.thinkingLevel) metaParts.push(`thinking: ${payload.thinkingLevel}`);
  metaParts.push("/fa menu · /resume · /fa off");
  lines.push(theme.fg("dim", metaParts.join(" · ")));
  if (payload.starters && payload.starters.length > 0) {
    const sample = payload.starters
      .slice(0, 2)
      .map((s) => `"${s}"`)
      .join("  ");
    lines.push(theme.fg("dim", `Try: ${sample}`));
  }
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

export function renderRemoteEntry(
  payload: RemoteEntryPayload,
  options: EntryRenderOptions,
  theme: Theme,
): Component | undefined {
  const { entry } = payload;
  const markdownTheme = getMarkdownTheme();

  switch (entry.kind) {
    case "user": {
      const data = (entry.data ?? {}) as UserEntryData;
      const text = formatContentParts(data.content);
      return new UserMessageComponent(text, markdownTheme, 1, undefined, entry.id);
    }
    case "assistant": {
      const data = (entry.data ?? {}) as AssistantEntryData;
      const hasContent = Boolean(data.text || data.thinking || data.error);
      // Tool-only assistant turns merge their arguments into the following tool_result cards.
      if (!hasContent) return undefined;
      const msg = assistantEntryToPiMessage(entry);
      return new AssistantMessageComponent(msg, !options.expanded, markdownTheme, undefined, 1);
    }
    case "tool_result": {
      const data = (entry.data ?? {}) as ToolResultEntryData;
      const toolName = data.toolName ?? "tool";
      const isError = data.isError === true;
      const text = formatContentParts(data.content).trim();
      const lines = text ? text.split("\n") : [];
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const argsSummary = payload.toolArgs === undefined ? "" : formatArgsSummary(payload.toolArgs, 60);
      const header = `${icon} ${theme.bold(toolName)}${argsSummary ? ` ${theme.fg("dim", argsSummary)}` : ""}`;

      const detailsText = data.details !== undefined ? JSON.stringify(data.details, null, 2) : undefined;
      const box = new Box(1, 0, (line) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", line));
      if (options.expanded) {
        const sections = [header];
        if (lines.length > 0) {
          if (lines.length > MAX_EXPANDED_TOOL_LINES) {
            const shown = lines.slice(0, MAX_EXPANDED_TOOL_LINES).join("\n");
            sections.push(
              theme.fg("dim", `${shown}\n… (${lines.length - MAX_EXPANDED_TOOL_LINES} more lines truncated)`),
            );
          } else {
            sections.push(theme.fg("dim", text));
          }
        }
        if (detailsText) sections.push(theme.fg("dim", `details: ${detailsText}`));
        box.addChild(new Text(sections.join("\n"), 0, 0));
      } else {
        const previewLines = lines.slice(0, 3);
        const more = lines.length - previewLines.length;
        const extra =
          more > 0
            ? ` (${more} more lines, ${options.keyHint("app.tools.expand", "to expand")})`
            : detailsText
              ? ` (details, ${options.keyHint("app.tools.expand", "to expand")})`
              : "";
        const body = previewLines.length > 0 ? `\n${theme.fg("dim", previewLines.join("\n"))}` : "";
        box.addChild(new Text(`${header}${theme.fg("dim", extra)}${body}`, 0, 0));
      }
      return box;
    }
    case "compaction": {
      const data = (entry.data ?? {}) as CompactionEntryData;
      const summary = data.summary?.trim() ?? "";
      const box = new Box(1, 0, (line) => theme.bg("customMessageBg", line));
      if (options.expanded && summary) {
        box.addChild(new Text(theme.fg("accent", "[compaction]"), 0, 0));
        box.addChild(new Markdown(summary, 0, 0, markdownTheme));
      } else {
        const hint = summary ? ` (${options.keyHint("app.tools.expand", "to expand")})` : "";
        box.addChild(
          new Text(`${theme.fg("accent", "[compaction]")} ${theme.fg("dim", `Context summarized${hint}`)}`, 0, 0),
        );
      }
      return box;
    }
    default:
      return undefined;
  }
}

export function hasLiveContent(state: RemoteViewState): boolean {
  if (state.status === "connecting" || state.status === "reconnecting") return true;
  if (state.sending || state.canceling || state.compacting) return true;
  if (state.retrying !== undefined) return true;
  if (state.activeTools.length > 0 || state.queuedMessages.length > 0) return true;
  if (state.liveReply && (state.liveReply.text.length > 0 || state.liveReply.thinking.length > 0)) return true;
  if (state.session?.status === "running") return true;
  return false;
}

function renderActiveToolLine(tool: ActiveTool, theme: Theme): string {
  const args = tool.args === undefined ? "" : formatArgsSummary(tool.args, 60);
  const base = `${theme.fg("warning", "●")} ${theme.bold(tool.name)}${args ? ` ${theme.fg("dim", args)}` : ""}`;
  const body = tool.output ?? tool.progress;
  if (!body) return base;
  const indented = body
    .split("\n")
    .slice(-4)
    .map((line) => `  ${theme.fg("dim", line)}`)
    .join("\n");
  return `${base}\n${indented}`;
}

export function createLiveWidgetComponent(getState: () => RemoteViewState, theme: Theme): Component {
  const markdownTheme = getMarkdownTheme();
  let msgComp: AssistantMessageComponent | undefined;
  let lastReply: LiveReply | undefined;

  return {
    invalidate() {
      msgComp?.invalidate();
    },
    render(width: number): string[] {
      const state = getState();
      if (!hasLiveContent(state)) {
        msgComp = undefined;
        lastReply = undefined;
        return [];
      }

      const container = new Container();
      const label = state.remoteName ?? "remote";

      if (state.status === "connecting") {
        container.addChild(new Text(theme.fg("accent", `Connecting to ${label}…`), 1, 0));
      } else if (state.status === "reconnecting") {
        const err = state.lastError ? ` (${state.lastError})` : "";
        container.addChild(new Text(theme.fg("warning", `Reconnecting to ${label}…${err}`), 1, 0));
      }

      if (state.compacting) {
        container.addChild(new Text(theme.fg("accent", `Compacting ${label} session…`), 1, 0));
      }

      if (state.retrying) {
        const secs = (state.retrying.delayMs / 1000).toFixed(1);
        container.addChild(
          new Text(
            theme.fg(
              "warning",
              `Retrying (${state.retrying.attempt}/${state.retrying.maxAttempts}) in ${secs}s: ${state.retrying.reason}`,
            ),
            1,
            0,
          ),
        );
      }

      if (state.liveReply && (state.liveReply.text.length > 0 || state.liveReply.thinking.length > 0)) {
        if (!msgComp) {
          msgComp = new AssistantMessageComponent(undefined, false, markdownTheme, undefined, 1);
        }
        if (state.liveReply !== lastReply) {
          lastReply = state.liveReply;
          const content: AssistantMessage["content"] = [];
          if (state.liveReply.thinking) content.push({ type: "thinking", thinking: state.liveReply.thinking });
          if (state.liveReply.text) content.push({ type: "text", text: state.liveReply.text });
          const partial: AssistantMessage = {
            role: "assistant",
            content,
            api: "fastagent-remote",
            provider: "fastagent",
            model: state.session?.model?.modelId ?? "remote",
            usage: ZERO_USAGE,
            stopReason: "pending",
            timestamp: Date.now(),
          };
          msgComp.updateContent(partial, true);
        }
        container.addChild(msgComp);
      } else {
        msgComp = undefined;
        lastReply = undefined;
      }

      for (const tool of state.activeTools) {
        container.addChild(new Text(renderActiveToolLine(tool, theme), 1, 0));
      }

      for (const queued of state.queuedMessages) {
        const preview = state.queuedPreviews[queued.id];
        const tag = queued.mode === "steer" ? "steer" : "queued";
        const text = preview ? `↳ ${tag}: ${preview}` : `↳ ${tag} message`;
        container.addChild(new Text(theme.fg("dim", text), 1, 0));
      }

      if (state.canceling) {
        container.addChild(new Text(theme.fg("warning", `Canceling ${label}…`), 1, 0));
      } else if (state.sending) {
        container.addChild(new Text(theme.fg("accent", `Sending to ${label}…`), 1, 0));
      } else if (state.session?.status === "running") {
        const queued = state.queuedMessages.length > 0 ? ` · ${state.queuedMessages.length} queued` : "";
        container.addChild(
          new Text(theme.fg("dim", `● ${label} running${queued}… (Esc cancel · ⌥↵ queue · ↵ steer)`), 1, 0),
        );
      }

      return container.render(width);
    },
  };
}

function sanitizeStatus(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * Pi-native 2-line footer (plus optional 3rd line for other extensions' statuses):
 * Line 1: remote identity, agent name, session title, and short id.
 * Line 2: left = token/cost stats + color-coded context % + live badges; right = (provider) model • thinking.
 */
export function renderRemoteFooterLines(
  state: RemoteViewState,
  width: number,
  theme: Theme,
  footerData?: ReadonlyFooterDataProvider,
): string[] {
  const remote = state.remoteName ?? "remote";
  const session = state.session;
  const statusIcon =
    state.status === "reconnecting"
      ? theme.fg("warning", "↻")
      : state.status === "connecting" || state.sending
        ? theme.fg("accent", "◌")
        : session?.status === "running"
          ? theme.fg("accent", "●")
          : theme.fg("success", "●");

  const agentName = state.agentInfo?.name;
  const hostLabel = agentName && agentName !== remote ? `${remote} (${agentName})` : remote;
  const sid = session ? shortId(session.id) : "—";
  const titlePart = session?.title ? ` • ${session.title}` : "";
  const identityRaw = `${statusIcon} ${theme.fg("accent", "☁")} ${theme.fg("dim", `${hostLabel}${titlePart} · ${sid}`)}`;
  const line1 = truncateToWidth(identityRaw, width, theme.fg("dim", "…"));

  const statsParts: string[] = [];
  const usageStr = formatUsageSummary(session?.usage);
  if (usageStr) statsParts.push(theme.fg("dim", usageStr));
  const ctxStr = formatContextSummary(session?.contextUsage, theme);
  if (ctxStr) statsParts.push(ctxStr.includes("\x1b[") ? ctxStr : theme.fg("dim", ctxStr));
  if (state.compacting) statsParts.push(theme.fg("accent", "compacting"));
  if (state.queuedMessages.length > 0) statsParts.push(theme.fg("dim", `${state.queuedMessages.length} queued`));
  if (state.status === "reconnecting") statsParts.push(theme.fg("warning", "reconnecting"));
  const statsLeft = statsParts.length > 0 ? statsParts.join(" ") : theme.fg("dim", "/fa menu");

  const model = session?.model ?? state.agentInfo?.defaultModel;
  const thinking = session?.thinkingLevel;
  const modelBase = model ? model.modelId : "default";
  const thinkingPart = thinking ? (thinking === "off" ? " • thinking off" : ` • ${thinking}`) : "";
  const rightShort = `${modelBase}${thinkingPart}`;
  const rightFull = model ? `(${model.provider}) ${rightShort}` : rightShort;

  const minGap = 2;
  const leftWidth = visibleWidth(statsLeft);
  let rightText = rightFull;
  if (leftWidth + minGap + visibleWidth(rightText) > width) {
    rightText = rightShort;
  }
  const styledRight = theme.fg("dim", rightText);
  const rightWidth = visibleWidth(styledRight);

  let line2: string;
  if (leftWidth + minGap + rightWidth <= width) {
    const pad = " ".repeat(width - leftWidth - rightWidth);
    line2 = `${statsLeft}${pad}${styledRight}`;
  } else {
    const availForLeft = Math.max(0, width - rightWidth - minGap);
    if (availForLeft >= 12) {
      const clippedLeft = truncateToWidth(statsLeft, availForLeft, theme.fg("dim", "…"));
      const pad = " ".repeat(Math.max(1, width - visibleWidth(clippedLeft) - rightWidth));
      line2 = `${clippedLeft}${pad}${styledRight}`;
    } else {
      line2 = truncateToWidth(`${statsLeft}  ${styledRight}`, width, theme.fg("dim", "…"));
    }
  }

  const lines = [line1, line2];
  const extStatuses = footerData?.getExtensionStatuses();
  if (extStatuses && extStatuses.size > 0) {
    const sorted = Array.from(extStatuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitizeStatus(text))
      .filter(Boolean);
    if (sorted.length > 0) {
      lines.push(truncateToWidth(sorted.join(" "), width, theme.fg("dim", "…")));
    }
  }
  return lines;
}
