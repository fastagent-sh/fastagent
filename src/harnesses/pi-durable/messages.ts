/**
 * pi-durable's input submissions as the Agent API's messages (agent-api.md §5): a submission is a message, its request
 * id carries the Caller's key, and its settlement is the message's end.
 */
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { AgentState, EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import {
  type AgentErrorData,
  type Message,
  type Session,
  type Tokens,
  type Usage,
  agentError,
  errorData,
} from "../../agent-api.ts";
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
}

/** The queued inputs in the order they will be taken: steers before follow-ups, each in arrival order. */
export function queuedInputs(inbox: InboxView | undefined): number[] {
  const items = inbox?.items ?? [];
  const of = (mode: "steer" | "followUp") => items.filter((item) => item.mode === mode).map((item) => item.id);
  return [...of("steer"), ...of("followUp")];
}

/** A message as the API has it. An ended one needs its answer entry: the entry pi-durable settled it with. */
export function messageOf(record: InputRecord, ids: Ids, answer?: EntryRecord): Message {
  const key = idempotencyKeyOf(record.requestId);
  const identity = {
    id: ids.encode(record.id),
    sessionId: ids.encode(record.conversationId),
    ...(key === undefined ? {} : { idempotencyKey: key }),
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
  // A run a tool ended (`control.terminate`) settles on the reply that called it, which is not an answer (§5.4).
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

/** The session as it is now, from its documents as one commit or one event snapshot holds them. */
export function sessionOf(
  id: string,
  live: LiveView | undefined,
  usage: UsageView | undefined,
  agent: Pick<AgentState, "model" | "thinkingLevel" | "instructions" | "tools"> | undefined,
): Session {
  const partial = live?.generation?.message as Pick<AssistantMessage, "content"> | undefined;
  const thinking = partial === undefined ? undefined : thinkingOf(partial);
  return {
    id,
    status: live?.run === undefined ? "idle" : "running",
    ...(agent?.model === undefined ? {} : { model: { provider: agent.model.provider, modelId: agent.model.modelId } }),
    ...(agent?.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
    ...(agent?.instructions === undefined ? {} : { instructions: agent.instructions }),
    // Only the list this API sets; pi-durable's other form (`{ remove }`) is set through `harness`, not here.
    ...(Array.isArray(agent?.tools) ? { tools: [...agent.tools] } : {}),
    ...(partial === undefined
      ? {}
      : { reply: { text: replyText(partial), ...(thinking === undefined ? {} : { thinking }) } }),
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
