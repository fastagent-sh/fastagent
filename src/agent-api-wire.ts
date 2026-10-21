/** JSON shapes shared by the Agent API's HTTP binding and client; the contract itself imports nothing. */
import * as Schema from "effect/Schema";
import type { ResumeEvent } from "./agent-api.ts";

const optional = Schema.optionalKey;
const ErrorBody = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  details: optional(Schema.Json),
});
export const RejectionBody = Schema.Struct({ error: ErrorBody });
export const UnknownBody = Schema.Struct({
  unknown: Schema.Struct({
    reason: Schema.String,
    sessionId: optional(Schema.String),
    messageId: optional(Schema.String),
  }),
});
const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const Image = Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String });
export const InvokeBody = Schema.Struct({
  sessionId: optional(Schema.String),
  content: Schema.Array(Schema.Union([Text, Image])),
  idempotencyKey: optional(Schema.String),
  whenBusy: optional(Schema.Literals(["queue", "steer", "reject"])),
});
export const CreateBody = Schema.Struct({
  from: optional(
    Schema.Struct({
      sessionId: Schema.String,
      entryId: optional(Schema.String),
      context: optional(Schema.Literals(["full", "recent"])),
    }),
  ),
  model: optional(Schema.Struct({ provider: Schema.String, modelId: Schema.String })),
  thinkingLevel: optional(Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
});
export const EmptyBody = Schema.Struct({});
const Identity = { messageId: Schema.String, idempotencyKey: optional(Schema.String) };
const DoneFields = {
  ...Identity,
  status: Schema.Literal("done"),
  entryId: optional(Schema.String),
  outcome: Schema.Struct({ status: Schema.String, error: optional(ErrorBody) }),
  answer: optional(Schema.Struct({ entryId: Schema.String, text: Schema.String })),
};
const Done = Schema.Struct(DoneFields);
export const MessageBody = Schema.Union([
  Schema.Struct({ ...Identity, status: Schema.Literal("queued"), position: Schema.Number }),
  Schema.Struct({ ...Identity, status: Schema.Literal("taken"), entryId: Schema.String }),
  Done,
]);
export const ReceiptBody = Schema.Struct({ sessionId: Schema.String, message: MessageBody, duplicate: Schema.Boolean });
export const SessionBody = Schema.Struct({ sessionId: Schema.String });
const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: optional(Schema.Number),
  cacheWriteTokens: optional(Schema.Number),
  cost: optional(Schema.Number),
});
const State = Schema.Struct({
  status: Schema.String,
  taken: Schema.Array(Schema.String),
  queued: Schema.Array(Schema.String),
  reply: optional(Schema.Struct({ text: Schema.String, thinking: optional(Schema.String) })),
  usage: Schema.Struct({ models: Schema.Record(Schema.String, Usage), tools: Schema.Record(Schema.String, Usage) }),
});
const Entry = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  parentEntryId: optional(Schema.String),
  timestamp: Schema.Number,
  kind: Schema.String,
  data: Schema.Json,
});
export const ReadBody = Schema.Struct({
  state: State,
  entries: Schema.Array(Entry),
  prev: optional(Schema.String),
  next: optional(Schema.String),
});
export const AbortBody = Schema.Struct({
  stopped: Schema.Struct({ taken: Schema.Array(Schema.String), queued: Schema.Array(Schema.String) }),
});
export const InfoBody = Schema.Struct({
  protocolVersion: Schema.Literal("1.0"),
  name: Schema.String,
  description: optional(Schema.String),
  inputs: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.Struct({ name: Schema.String, description: optional(Schema.String) })),
});

export function decodeWire<T>(schema: Schema.Top, value: unknown, strict = false): T {
  Schema.decodeUnknownSync(schema as never, { onExcessProperty: strict ? "error" : "ignore" })(value);
  return value as T;
}

const events: Record<string, Schema.Top> = {
  entry: Schema.Struct({ type: Schema.Literal("entry"), entry: Entry }),
  state: Schema.Struct({ type: Schema.Literal("state"), state: State }),
  done: Schema.Struct({ type: Schema.Literal("done"), message: Done }),
  rejected: Schema.Struct({ type: Schema.Literal("rejected"), error: ErrorBody }),
  serving_error: Schema.Struct({ type: Schema.Literal("serving_error"), error: ErrorBody }),
  message_delta: Schema.Struct({
    type: Schema.Literal("message_delta"),
    channel: Schema.Literals(["text", "thinking"]),
    delta: Schema.String,
  }),
  tool_started: Schema.Struct({
    type: Schema.Literal("tool_started"),
    toolCallId: Schema.String,
    name: Schema.String,
    args: Schema.Json,
  }),
  tool_progress: Schema.Struct({
    type: Schema.Literal("tool_progress"),
    toolCallId: Schema.String,
    text: Schema.String,
  }),
  retry_scheduled: Schema.Struct({
    type: Schema.Literal("retry_scheduled"),
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    delayMs: Schema.Number,
    reason: Schema.String,
  }),
};

export function decodeEvent(value: unknown): ResumeEvent {
  const envelope = decodeWire<{ type: string }>(Schema.Struct({ type: Schema.String }), value);
  const schema = Object.hasOwn(events, envelope.type) ? events[envelope.type] : undefined;
  return schema === undefined ? (envelope as ResumeEvent) : decodeWire(schema, value);
}
