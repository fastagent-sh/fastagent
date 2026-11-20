/**
 * Rendering adapters from FastAgent Agent API objects (`Entry`, `RemoteViewState`, `Usage`) to Pi TUI
 * components, reusing Pi's exported message and compaction components for visual parity.
 */
import type { AssistantMessage, StopReason, Usage as PiUsage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  CompactionSummaryMessageComponent,
  type EntryRenderOptions,
  type Theme,
  UserMessageComponent,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContentPart, Entry, Json, Tokens, Usage } from "@fastagent-sh/client";
import type { ActiveTool, LiveReply, RemoteViewState } from "./controller.ts";

export interface RemoteEntryPayload {
  remoteName: string;
  sessionId: string;
  entry: Entry;
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

const ZERO_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function formatArgsSummary(args: Json, maxLen = 80): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args.length > maxLen ? `${args.slice(0, maxLen - 1)}…` : args;
  if (typeof args === "object" && !Array.isArray(args)) {
    const pairs = Object.entries(args)
      .slice(0, 3)
      .map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        const clipped = val && val.length > 40 ? `${val.slice(0, 39)}…` : val;
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

function formatUsageTotals(usage: Usage | undefined): string {
  if (!usage) return "";
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const tokens of Object.values(usage.models)) {
    input += tokens.inputTokens + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0);
    output += tokens.outputTokens;
    cost += tokens.cost ?? 0;
  }
  for (const tokens of Object.values(usage.tools)) {
    cost += tokens.cost ?? 0;
  }
  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  const parts = [`↑${fmt(input)} ↓${fmt(output)}`];
  if (cost > 0) parts.push(`$${cost.toFixed(3)}`);
  return parts.join(" ");
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
      const container = new Container();
      const hasContent = Boolean(data.text || data.thinking || data.error);
      if (hasContent) {
        const msg = assistantEntryToPiMessage(entry);
        container.addChild(new AssistantMessageComponent(msg, !options.expanded, markdownTheme, undefined, 1));
      }
      if (data.toolCalls && data.toolCalls.length > 0) {
        for (const call of data.toolCalls) {
          const summary = formatArgsSummary(call.args);
          const line = `${theme.fg("accent", "⚙")} ${theme.bold(call.name)}${summary ? ` ${theme.fg("dim", summary)}` : ""}`;
          container.addChild(new Text(line, 1, 0));
        }
      }
      return container.children.length > 0 ? container : undefined;
    }
    case "tool_result": {
      const data = (entry.data ?? {}) as ToolResultEntryData;
      const toolName = data.toolName ?? "tool";
      const isError = data.isError === true;
      const text = formatContentParts(data.content).trim();
      const lines = text ? text.split("\n") : [];
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const header = `${icon} ${theme.bold(toolName)}`;

      const detailsText = data.details !== undefined ? JSON.stringify(data.details, null, 2) : undefined;
      const box = new Box(1, 0, (line) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", line));
      if (options.expanded) {
        const sections = [header];
        if (lines.length > 0) sections.push(theme.fg("dim", text));
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
      const component = new CompactionSummaryMessageComponent(
        {
          role: "compactionSummary",
          summary: data.summary ?? "",
          tokensBefore: 0,
          timestamp: entry.timestamp,
        },
        markdownTheme,
        1,
      );
      component.setExpanded(options.expanded);
      return component;
    }
    default:
      return undefined;
  }
}

export function hasLiveContent(state: RemoteViewState): boolean {
  if (state.status === "connecting" || state.status === "reconnecting") return true;
  if (state.compacting) return true;
  if (state.retrying !== undefined) return true;
  if (state.activeTools.length > 0) return true;
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
    .slice(-6)
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

      if (state.session?.status === "running") {
        const queued = state.queuedMessages.length > 0 ? ` · ${state.queuedMessages.length} queued` : "";
        container.addChild(
          new Text(theme.fg("dim", `● ${label} running${queued}… (Esc to cancel, type to steer)`), 1, 0),
        );
      }

      return container.render(width);
    },
  };
}

export function renderRemoteFooterLine(state: RemoteViewState, width: number, theme: Theme): string {
  const remote = state.remoteName ?? "remote";
  const session = state.session;
  const statusIcon =
    state.status === "reconnecting"
      ? theme.fg("warning", "↻")
      : session?.status === "running"
        ? theme.fg("accent", "●")
        : theme.fg("success", "●");
  const usageStr = formatUsageTotals(session?.usage);
  const sid = session ? shortId(session.id) : "—";
  const titleStr = session?.title
    ? session.title.length > 28
      ? `${session.title.slice(0, 27)}…`
      : session.title
    : undefined;
  const leftParts = [`${statusIcon} fastagent:${remote}`, theme.fg("dim", titleStr ? `${titleStr} (${sid})` : sid)];
  if (state.compacting) leftParts.push(theme.fg("accent", "compacting"));
  if (state.queuedMessages.length > 0) leftParts.push(theme.fg("dim", `queued:${state.queuedMessages.length}`));
  if (usageStr) leftParts.push(theme.fg("dim", usageStr));
  const left = leftParts.join(" · ");

  const model = session?.model ?? state.agentInfo?.defaultModel;
  const modelStr = model ? `${model.provider}/${model.modelId}` : "default";
  const thinking = session?.thinkingLevel ? ` · ${session.thinkingLevel}` : "";
  const right = theme.fg("dim", `${modelStr}${thinking}`);

  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width);
}
