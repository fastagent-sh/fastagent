/**
 * Pure state types and event reducer for `@fastagent-sh/pi-remote`: maps Agent API `SessionEvent` records into
 * immutable `RemoteViewState` snapshots and declarative side-effect outputs without performing I/O.
 */
import type {
  AgentInfo,
  ContentPart,
  Entry,
  Json,
  Message,
  QueuedMessage,
  SendRequest,
  Session,
  SessionEvent,
} from "@fastagent-sh/client";

export interface ActiveTool {
  toolCallId: string;
  name: string;
  args?: Json;
  progress?: string;
  output?: string;
}

export interface LiveReply {
  text: string;
  thinking: string;
}

interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface RemoteViewState {
  status: ConnectionStatus;
  remoteName?: string | undefined;
  agentInfo?: AgentInfo | undefined;
  session?: Session | undefined;
  liveReply?: LiveReply | undefined;
  activeTools: readonly ActiveTool[];
  queuedMessages: readonly QueuedMessage[];
  queuedPreviews: Readonly<Record<string, string>>;
  sending: boolean;
  canceling: boolean;
  compacting: boolean;
  retrying?: RetryNotice | undefined;
  lastEntryId?: string | undefined;
  lastError?: string | undefined;
}

export const EMPTY_VIEW_STATE: RemoteViewState = {
  status: "disconnected",
  activeTools: [],
  queuedMessages: [],
  queuedPreviews: {},
  sending: false,
  canceling: false,
  compacting: false,
};

/** Pure transition result returned by {@link reduceSessionEvent}. */
export interface EventReduction {
  readonly state: RemoteViewState;
  readonly lastAssistantText?: string;
  readonly toolCallArgs?: readonly (readonly [string, Json])[];
  readonly errorMessage?: string;
  readonly doneMessage?: Message;
  readonly entry?: Entry;
}

export function activeToolsFromSession(session: Session): ActiveTool[] {
  return (session.activeTools ?? []).map((tool) => ({
    toolCallId: tool.toolCallId,
    name: tool.name,
    ...(tool.progress === undefined ? {} : { progress: tool.progress }),
  }));
}

function mergeActiveTools(previous: readonly ActiveTool[], session: Session): ActiveTool[] {
  if (session.status === "idle") return [];
  const prevById = new Map(previous.map((tool) => [tool.toolCallId, tool]));
  return (session.activeTools ?? []).map((tool) => {
    const existing = prevById.get(tool.toolCallId);
    return {
      toolCallId: tool.toolCallId,
      name: tool.name,
      ...(existing?.args !== undefined ? { args: existing.args } : {}),
      ...(tool.progress !== undefined
        ? { progress: tool.progress }
        : existing?.progress !== undefined
          ? { progress: existing.progress }
          : {}),
      ...(existing?.output !== undefined ? { output: existing.output } : {}),
    };
  });
}

export function previewOfContent(content: SendRequest["content"]): string {
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join(" ");
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 60 ? `${singleLine.slice(0, 59)}…` : singleLine;
}

export function autoTitleOf(text: string): string | undefined {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.startsWith("/")) return undefined;
  return cleaned.length > 48 ? `${cleaned.slice(0, 47)}…` : cleaned;
}

export function omitKeys(
  record: Readonly<Record<string, string>>,
  remove: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !remove.has(k)));
}

export function buildSendContent(
  text: string,
  images?: readonly { mimeType: string; data: string }[],
): SendRequest["content"] {
  if (!images || images.length === 0) return text;
  const parts: Extract<ContentPart, { type: "text" } | { type: "image"; data: string }>[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const img of images) {
    parts.push({ type: "image", mimeType: img.mimeType, data: img.data });
  }
  return parts;
}

/** Purely reduce one `SessionEvent` into the next `RemoteViewState` and any side-effect payloads. */
export function reduceSessionEvent(
  state: RemoteViewState,
  event: SessionEvent,
  options: { readonly replayed: boolean },
): EventReduction {
  switch (event.type) {
    case "state": {
      const reply = event.session.reply;
      const prevReply = state.liveReply;
      let liveReply: LiveReply | undefined;
      if (event.session.status !== "idle") {
        const incoming = reply ? { text: reply.text, thinking: reply.thinking ?? "" } : undefined;
        if (incoming && prevReply) {
          liveReply = {
            text: prevReply.text.startsWith(incoming.text) ? prevReply.text : incoming.text,
            thinking: prevReply.thinking.startsWith(incoming.thinking) ? prevReply.thinking : incoming.thinking,
          };
        } else {
          liveReply = incoming ?? prevReply;
        }
      }
      return {
        state: {
          ...state,
          status: "connected",
          session: event.session,
          liveReply,
          activeTools: mergeActiveTools(state.activeTools, event.session),
          queuedMessages: event.session.queuedMessages ?? [],
          compacting: event.session.compacting === true,
          retrying: undefined,
        },
      };
    }
    case "delta": {
      const current = state.liveReply ?? { text: "", thinking: "" };
      const liveReply: LiveReply =
        event.channel === "thinking"
          ? { text: current.text, thinking: current.thinking + event.text }
          : { text: current.text + event.text, thinking: current.thinking };
      const session =
        state.session && state.session.status === "idle"
          ? { ...state.session, status: "running" as const }
          : state.session;
      return {
        state: {
          ...state,
          ...(session !== undefined ? { session } : {}),
          liveReply,
          retrying: undefined,
        },
      };
    }
    case "tool_started": {
      const existing = state.activeTools.some((t) => t.toolCallId === event.toolCallId);
      const activeTools = existing
        ? state.activeTools.map((t) =>
            t.toolCallId === event.toolCallId ? { ...t, name: event.name, args: event.args } : t,
          )
        : [...state.activeTools, { toolCallId: event.toolCallId, name: event.name, args: event.args }];
      return { state: { ...state, activeTools } };
    }
    case "tool_progress": {
      const found = state.activeTools.some((t) => t.toolCallId === event.toolCallId);
      const patch = { progress: event.text, ...(event.output === undefined ? {} : { output: event.output }) };
      const activeTools = found
        ? state.activeTools.map((t) => (t.toolCallId === event.toolCallId ? { ...t, ...patch } : t))
        : [...state.activeTools, { toolCallId: event.toolCallId, name: "tool", ...patch }];
      return { state: { ...state, activeTools } };
    }
    case "retrying":
      return {
        state: {
          ...state,
          retrying: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            reason: event.reason,
          },
        },
      };
    case "compaction_started":
      return { state: { ...state, compacting: true } };
    case "compaction_failed":
      return {
        state: { ...state, compacting: false, lastError: event.error },
        errorMessage: `Compaction failed: ${event.error}`,
      };
    case "entry": {
      const entry = event.entry;
      let nextLiveReply = state.liveReply;
      let nextActiveTools = state.activeTools;
      let nextRetrying = state.retrying;
      let nextSession = state.session;
      let nextQueued = state.queuedMessages;
      let nextPreviews = state.queuedPreviews;
      let nextCompacting = state.compacting;
      let lastAssistantText: string | undefined;
      let toolCallArgs: (readonly [string, Json])[] | undefined;

      if (entry.kind === "user") {
        const data = entry.data as { messageId?: unknown } | null;
        if (data && typeof data.messageId === "string") {
          nextQueued = nextQueued.filter((q) => q.id !== data.messageId);
          if (data.messageId in nextPreviews) nextPreviews = omitKeys(nextPreviews, new Set([data.messageId]));
        }
        if (!options.replayed && nextSession?.status === "idle") {
          nextSession = { ...nextSession, status: "running" };
        }
      } else if (entry.kind === "assistant") {
        const data = entry.data as { text?: unknown; toolCalls?: Array<{ id?: unknown; args?: Json }> } | null;
        if (typeof data?.text === "string" && data.text.trim().length > 0) {
          lastAssistantText = data.text;
        }
        const extracted: (readonly [string, Json])[] = [];
        for (const call of data?.toolCalls ?? []) {
          if (typeof call.id === "string" && call.args !== undefined) {
            extracted.push([call.id, call.args]);
          }
        }
        if (extracted.length > 0) toolCallArgs = extracted;
        nextLiveReply = undefined;
        nextRetrying = undefined;
      } else if (entry.kind === "tool_result") {
        const data = entry.data as { toolCallId?: unknown } | null;
        if (data && typeof data.toolCallId === "string") {
          nextActiveTools = state.activeTools.filter((t) => t.toolCallId !== data.toolCallId);
        }
      } else if (entry.kind === "compaction") {
        nextCompacting = false;
      }

      return {
        state: {
          ...state,
          ...(nextSession !== undefined ? { session: nextSession } : {}),
          lastEntryId: entry.id,
          liveReply: nextLiveReply,
          activeTools: nextActiveTools,
          queuedMessages: nextQueued,
          queuedPreviews: nextPreviews,
          compacting: nextCompacting,
          retrying: nextRetrying,
        },
        ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
        ...(toolCallArgs === undefined ? {} : { toolCallArgs }),
        entry,
      };
    }
    case "done": {
      const lastAssistantText =
        event.message.answer?.text && event.message.answer.text.trim().length > 0
          ? event.message.answer.text
          : undefined;
      const failed = event.message.status === "failed" ? event.message.error?.message : undefined;
      const session = state.session ? { ...state.session, status: "idle" as const } : undefined;
      return {
        state: {
          ...state,
          ...(session !== undefined ? { session } : {}),
          liveReply: undefined,
          activeTools: [],
          queuedMessages: state.queuedMessages.filter((q) => q.id !== event.message.id),
          queuedPreviews: omitKeys(state.queuedPreviews, new Set([event.message.id])),
          canceling: false,
          retrying: undefined,
          ...(failed !== undefined ? { lastError: failed } : {}),
        },
        ...(lastAssistantText === undefined ? {} : { lastAssistantText }),
        doneMessage: event.message,
      };
    }
    case "stream_error":
      return { state };
  }
}
