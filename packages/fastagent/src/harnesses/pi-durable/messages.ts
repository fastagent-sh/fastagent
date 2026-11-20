/**
 * pi-durable's input submissions as the Agent API's messages: a submission is a message, its request
 * id carries the Caller's key, and its settlement is the message's end.
 */
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import {
  type AgentState,
  type EntryRecord,
  type SubmissionRecord,
  type ToolSlot,
  defineDoc,
  defineDocFamily,
} from "@earendil-works/pi-durable";
import {
  type ActiveTool,
  type AgentErrorData,
  type Message,
  type Metadata,
  type QueuedMessage,
  type Session,
  type Tokens,
  type Usage,
  agentError,
  errorData,
} from "@fastagent-sh/client/agent-api";
import { hasToolCalls, replyText, thinkingOf, usageOf } from "./entries.ts";
import type { Ids } from "./ids.ts";

export type InputRecord = Extract<SubmissionRecord, { type: "input" }>;
export type EndedRecord = Extract<InputRecord, { status: "done" | "unanswered" }>;

const KEY = "key:";
/**
 * How pi-ai's `Models.applyAuth` says a provider has no credential (`ModelsError` "auth"). The settled submission keeps
 * only that text, and the outcome is read from what was recorded, so it does not change once a credential is added.
 */
const NOT_CONFIGURED = "Provider is not configured: ";

/**
 * A message's metadata, keyed by its submission's id: written in the commit that admits the message, never changed.
 * Session-scoped, since a submission id is unique in the storage and a fork takes none of its source's messages.
 */
export const MetadataDoc = defineDocFamily<{ metadata: Metadata }, null>({
  kind: "fastagent.message-metadata",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ metadata: {} }),
  checkpointWhen: () => false,
});

export type SessionMetaState = {
  title: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  deleted: boolean;
};

/**
 * Per-session metadata and soft-delete tombstone. `fork: "initial"` keeps a forked session from inheriting its
 * parent's title, creation timestamp, or deletion state.
 */
export const SessionMetaDoc = defineDoc<SessionMetaState>({
  kind: "fastagent.session-meta",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ title: null, createdAt: null, updatedAt: null, deleted: false }),
  checkpointWhen: () => false,
});

/** Every message is submitted with a request id, so its entry can name it: the Caller's key, or one of our own. */
export function requestIdFor(idempotencyKey: string | undefined): string {
  return idempotencyKey === undefined ? `id:${randomUUID()}` : `${KEY}${idempotencyKey}`;
}

function idempotencyKeyOf(requestId: string | undefined): string | undefined {
  return requestId?.startsWith(KEY) ? requestId.slice(KEY.length) : undefined;
}

export function isInput(record: SubmissionRecord | undefined): record is InputRecord {
  return record?.type === "input";
}

export function hasEnded(record: InputRecord): record is EndedRecord {
  return record.status === "done" || record.status === "unanswered";
}

/** What a conversation's `pi.inbox`, `pi.usage` and `pi.live` say, as the documents and an event snapshot hold them. */
export interface InboxView {
  readonly items: readonly { readonly id: number; readonly mode: string }[];
}
export interface UsageView {
  readonly models: Readonly<Record<string, Parameters<typeof usageOf>[0]>>;
  readonly tools: Readonly<Record<string, Parameters<typeof usageOf>[0]>>;
}
export interface LiveView {
  readonly run?: { readonly inputs: readonly number[] };
  readonly generation?: { readonly message?: unknown };
  readonly tools?: readonly ToolSlot[];
  readonly compactions?: readonly { readonly taskId: number; readonly trigger: "manual" | "threshold" | "overflow" }[];
}

/** The queued inputs in the order they will be taken: steers before follow-ups, each in arrival order. */
export function queuedInputs(inbox: InboxView | undefined): number[] {
  const items = inbox?.items ?? [];
  const of = (mode: "steer" | "followUp") => items.filter((item) => item.mode === mode).map((item) => item.id);
  return [...of("steer"), ...of("followUp")];
}

/** A message as the API has it. An ended one needs its answer entry: the entry pi-durable settled it with. */
export function messageOf(record: InputRecord, ids: Ids, metadata?: Metadata, answer?: EntryRecord): Message {
  const key = idempotencyKeyOf(record.requestId);
  const identity = {
    id: ids.encode(record.id),
    sessionId: ids.encode(record.conversationId),
    ...(key === undefined ? {} : { idempotencyKey: key }),
    ...(metadata === undefined ? {} : { metadata }),
  };
  switch (record.status) {
    case "queued":
      return { ...identity, status: "queued" };
    case "placed":
      return { ...identity, status: "running", entryId: ids.encode(record.entry) };
    default:
      return {
        ...identity,
        ...(record.entry === undefined ? {} : { entryId: ids.encode(record.entry) }),
        ...end(record, ids, answer),
      };
  }
}

function end(
  record: EndedRecord,
  ids: Ids,
  answer: EntryRecord | undefined,
): Pick<Message, "status" | "answer" | "error"> {
  if (record.status === "unanswered") return unanswered(record);
  const reply = answer?.model?.[0];
  if (reply?.role !== "assistant") {
    throw new Error(`message ${record.id} was answered by entry ${record.answer}, which holds no reply`);
  }
  // A run a tool ended (`control.terminate`) settles on the reply that called it, which is not an answer.
  if (hasToolCalls(reply)) return { status: "completed" };
  return {
    status: reply.stopReason === "length" ? "incomplete" : "completed",
    answer: { entryId: ids.encode(record.answer), text: replyText(reply) },
  };
}

function unanswered(record: Extract<EndedRecord, { status: "unanswered" }>): Pick<Message, "status" | "error"> {
  const detail = typeof record.detail === "string" ? record.detail : undefined;
  const failed = (error: AgentErrorData) => ({ status: "failed" as const, error: errorData(error) });
  switch (record.reason) {
    case "aborted":
      return { status: "canceled" };
    case "no_model":
      return failed(
        agentError("missing_model", "The session's model was not among the agent's models when it was to answer"),
      );
    case "model_error": {
      const message = detail ?? "The model call failed";
      if (message.startsWith(NOT_CONFIGURED)) return failed(agentError("auth_required", message));
      // pi-ai classifies a failed reply by its error text alone, which is all a settled submission keeps.
      const retryable = isRetryableAssistantError({ stopReason: "error", errorMessage: message } as AssistantMessage);
      return failed({ ...errorData(agentError("model_error", message)), retryable });
    }
    case "reset":
      return failed(agentError("internal", "The session was reset before this message was answered"));
    default:
      return failed(
        agentError("internal", detail ?? `The message was not answered: ${record.reason}`, { reason: record.reason }),
      );
  }
}

function lastProgressLine(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line;
  }
  return undefined;
}

function activeToolsOf(live: LiveView | undefined): ActiveTool[] {
  const tools = live?.tools ?? [];
  const active: ActiveTool[] = [];
  for (const slot of tools) {
    if (slot.status === "done") continue;
    const progress = lastProgressLine(slot.output);
    active.push({
      toolCallId: slot.callId,
      name: slot.name,
      status: slot.status,
      ...(progress === undefined ? {} : { progress }),
    });
  }
  return active;
}

function queuedMessagesOf(inbox: InboxView | undefined, ids: Ids | undefined): QueuedMessage[] {
  if (!inbox || !ids) return [];
  const steers: QueuedMessage[] = [];
  const queued: QueuedMessage[] = [];
  for (const item of inbox.items) {
    if (item.mode === "steer") steers.push({ id: ids.encode(item.id), mode: "steer" });
    else if (item.mode === "followUp") queued.push({ id: ids.encode(item.id), mode: "queue" });
  }
  return [...steers, ...queued];
}

/** The session as it is now, from its documents as one commit or one event snapshot holds them. */
export function sessionOf(
  id: string,
  live: LiveView | undefined,
  usage: UsageView | undefined,
  agent: Pick<AgentState, "model" | "thinkingLevel" | "instructions" | "tools"> | undefined,
  inbox?: InboxView,
  meta?: SessionMetaState,
  ids?: Ids,
): Session {
  const partial = live?.generation?.message as Pick<AssistantMessage, "content"> | undefined;
  const thinking = partial === undefined ? undefined : thinkingOf(partial);
  const activeTools = activeToolsOf(live);
  const queuedMessages = queuedMessagesOf(inbox, ids);
  const compacting = (live?.compactions?.length ?? 0) > 0;
  return {
    id,
    status: live?.run === undefined ? "idle" : "running",
    ...(meta?.title ? { title: meta.title } : {}),
    ...(typeof meta?.createdAt === "number" ? { createdAt: meta.createdAt } : {}),
    ...(typeof meta?.updatedAt === "number" ? { updatedAt: meta.updatedAt } : {}),
    ...(agent?.model === undefined ? {} : { model: { provider: agent.model.provider, modelId: agent.model.modelId } }),
    ...(agent?.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
    ...(agent?.instructions === undefined ? {} : { instructions: agent.instructions }),
    // Only the list this API sets; pi-durable's other form (`{ remove }`) is set through `harness`, not here.
    ...(Array.isArray(agent?.tools) ? { tools: [...agent.tools] } : {}),
    ...(partial === undefined
      ? {}
      : { reply: { text: replyText(partial), ...(thinking === undefined ? {} : { thinking }) } }),
    ...(activeTools.length > 0 ? { activeTools } : {}),
    ...(queuedMessages.length > 0 ? { queuedMessages } : {}),
    ...(compacting ? { compacting: true } : {}),
    usage: usageOfState(usage),
  };
}

/** What a conversation's `pi.usage`, or the instance's total, says it spent. */
export function usageOfState(usage: UsageView | undefined): Usage {
  return { models: tokensOf(usage?.models), tools: tokensOf(usage?.tools) };
}

function tokensOf(bucket: UsageView["models"] | undefined): Record<string, Tokens> {
  return Object.fromEntries(Object.entries(bucket ?? {}).map(([key, value]) => [key, usageOf(value)]));
}
