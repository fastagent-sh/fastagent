/**
 * pi-durable's input submissions as the Agent API's messages (agent-api.md §4): a submission is a message, its request
 * id carries the Caller's key, and its settlement is the message's outcome.
 */
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import { type DoneMessage, type MessageStatus, type Outcome, type SessionState, agentError } from "../../agent-api.ts";
import { hasToolCalls, replyText, thinkingOf } from "./entries.ts";
import type { Ids } from "./ids.ts";

export type InputRecord = Extract<SubmissionRecord, { type: "input" }>;
export type EndedRecord = Extract<InputRecord, { status: "done" | "unanswered" }>;

const KEY = "key:";

/** Every message is submitted with a request id, so its entry can name it: the Caller's key, or one of our own. */
export function requestIdFor(idempotencyKey: string | undefined): string {
  return idempotencyKey === undefined ? `id:${randomUUID()}` : `${KEY}${idempotencyKey}`;
}

export function idempotencyKeyOf(requestId: string | undefined): string | undefined {
  return requestId?.startsWith(KEY) ? requestId.slice(KEY.length) : undefined;
}

export function isInput(record: SubmissionRecord | undefined): record is InputRecord {
  return record?.type === "input";
}

export function hasEnded(record: InputRecord): record is EndedRecord {
  return record.status === "done" || record.status === "unanswered";
}

/** What a conversation's `pi.inbox` and `pi.live` say about its messages, as the documents and an event snapshot hold it. */
export interface InboxView {
  readonly items: readonly { readonly id: number; readonly mode: string }[];
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

/**
 * A message's status. A queued one needs its conversation's inbox for its position, an ended one its answer entry: the
 * entry pi-durable settled it with.
 */
export function messageStatus(
  record: InputRecord,
  ids: Ids,
  reads: { inbox?: InboxView; answer?: EntryRecord },
): MessageStatus {
  const key = idempotencyKeyOf(record.requestId);
  const identity = { messageId: ids.encode(record.id), ...(key === undefined ? {} : { idempotencyKey: key }) };
  switch (record.status) {
    case "queued":
      return { ...identity, status: "queued", position: queuedInputs(reads.inbox).indexOf(record.id) };
    case "placed":
      return { ...identity, status: "taken", entryId: ids.encode(record.entry) };
    default:
      return { ...identity, ...ended(record, ids, reads.answer) };
  }
}

export function doneMessage(record: EndedRecord, ids: Ids, answer: EntryRecord | undefined): DoneMessage {
  return messageStatus(record, ids, { ...(answer === undefined ? {} : { answer }) }) as DoneMessage;
}

function ended(record: EndedRecord, ids: Ids, answer: EntryRecord | undefined): Omit<DoneMessage, "messageId"> {
  const entry = record.entry === undefined ? {} : { entryId: ids.encode(record.entry) };
  if (record.status === "unanswered") return { status: "done", ...entry, outcome: unanswered(record) };
  const reply = answer?.model?.[0];
  if (reply?.role !== "assistant") {
    throw new Error(`message ${record.id} was answered by entry ${record.answer}, which holds no reply`);
  }
  // A run a tool ended (`control.terminate`) settles on the reply that called it, which is not an answer (§4).
  if (hasToolCalls(reply)) return { status: "done", ...entry, outcome: { status: "completed" } };
  return {
    status: "done",
    ...entry,
    outcome: { status: reply.stopReason === "length" ? "max_tokens" : "completed" },
    answer: { entryId: ids.encode(record.answer), text: replyText(reply) },
  };
}

function unanswered(record: Extract<EndedRecord, { status: "unanswered" }>): Outcome {
  const detail = typeof record.detail === "string" ? record.detail : undefined;
  switch (record.reason) {
    case "aborted":
      return { status: "canceled" };
    case "no_model":
      return { status: "failed", error: agentError("missing_model", "The agent has no model to answer with") };
    case "model_error": {
      const message = detail ?? "The model call failed";
      // pi-ai classifies a failed reply by its error text alone, which is all a settled submission keeps.
      const retryable = isRetryableAssistantError({ stopReason: "error", errorMessage: message } as AssistantMessage);
      return { status: "failed", error: { ...agentError("model_error", message), retryable } };
    }
    case "reset":
      return {
        status: "failed",
        error: agentError("internal", "The session was reset before this message was answered"),
      };
    default:
      return {
        status: "failed",
        error: agentError("internal", detail ?? `The message was not answered: ${record.reason}`, {
          reason: record.reason,
        }),
      };
  }
}

export function sessionState(live: LiveView | undefined, inbox: InboxView | undefined, ids: Ids): SessionState {
  const partial = live?.generation?.message as Pick<AssistantMessage, "content"> | undefined;
  const thinking = partial === undefined ? undefined : thinkingOf(partial);
  return {
    status: live?.run === undefined ? "idle" : "running",
    taken: (live?.run?.inputs ?? []).map((id) => ids.encode(id)),
    queued: queuedInputs(inbox).map((id) => ids.encode(id)),
    ...(partial === undefined
      ? {}
      : { reply: { text: replyText(partial), ...(thinking === undefined ? {} : { thinking }) } }),
  };
}
