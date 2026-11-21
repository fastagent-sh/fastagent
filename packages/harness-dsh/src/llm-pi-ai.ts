/**
 * DSH `LlmAdapter` backed directly by FastAgent's `@earendil-works/pi-ai` `Models` registry.
 * Preserves provider auth resolution (`AUTH` -> `auth_required`), streaming text/thinking/tool-call deltas,
 * reasoning effort mapping, image attachments, and exact per-call cost reporting.
 */
import {
  LlmAdapter,
  LlmError,
  type ReasoningEffortId,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  ImageContent,
  JsonObject,
  Message as PiMessage,
  Models,
  TextContent,
  ThinkingLevel as PiThinkingLevel,
  Tool as PiTool,
  ToolCall as PiToolCall,
  ToolResultMessage as PiToolResultMessage,
} from "@earendil-works/pi-ai";
import type { DshStoredAttachment, DshTelemetryContext, DshTelemetrySpan } from "./types.ts";

/** Inline image marker embedded in DSH user messages so adapters can supply raw bytes to pi-ai. */
export const IMAGE_REF_PREFIX = "__fastagent_image_ref__:";

interface PiAiCostRecord {
  readonly provider: string;
  readonly modelId: string;
  readonly cost: number;
}

export interface PiAiAdapterHooks {
  /** Resolve a durable attachment ref for a session so image blocks reach pi-ai as base64. */
  resolveAttachment?: (sessionId: string, ref: string) => Promise<DshStoredAttachment | undefined>;
  /** Report the exact cost of a completed model call. */
  onCallCost?: (sessionId: string | undefined, record: PiAiCostRecord) => void;
  /** Optional telemetry context for wrapping model calls in content-free spans. */
  telemetry?: DshTelemetryContext;
}

const VALID_REASONING: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function toPiReasoning(effort: string | undefined): PiThinkingLevel | undefined {
  if (effort === undefined || effort === "off") return undefined;
  if (effort === "max") return "xhigh";
  return VALID_REASONING.has(effort) ? (effort as PiThinkingLevel) : undefined;
}

function classifyPiError(message: string): { code: "AUTH" | "RATE_LIMIT" | "SERVER" | "PI_AI_ERROR"; status?: number } {
  const lower = message.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("credential") ||
    lower.includes("api key")
  ) {
    return { code: "AUTH", status: 401 };
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return { code: "RATE_LIMIT", status: 429 };
  }
  if (lower.includes("503") || lower.includes("overload") || lower.includes("temporarily unavailable")) {
    return { code: "SERVER", status: 503 };
  }
  return { code: "PI_AI_ERROR" };
}

function extractText(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

async function toPiMessages(
  messages: readonly RequestMessage[],
  system: string | undefined,
  sessionId: string | undefined,
  resolveAttachment: PiAiAdapterHooks["resolveAttachment"],
): Promise<PiMessage[]> {
  const out: PiMessage[] = [];
  if (system !== undefined && system.length > 0) {
    out.push({ role: "system", content: system, timestamp: Date.now() });
  }
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "system") {
      const text = extractText(msg.content);
      if (text.length > 0) {
        out.push({ role: "system", content: text, timestamp: Date.now() });
      }
      continue;
    }
    if (msg.role === "developer") {
      const text = extractText(msg.content);
      if (text.length > 0) {
        out.push({ role: "system", content: text, timestamp: Date.now() });
      }
      continue;
    }
    if (msg.role === "user") {
      if ("source" in msg && msg.source?.kind === "fastagent-recovery") continue;
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content, timestamp: Date.now() });
        continue;
      }
      const parts: Array<TextContent | ImageContent> = [];
      for (const block of msg.content) {
        if (block.type !== "text") continue;
        if (block.text.startsWith(IMAGE_REF_PREFIX) && sessionId !== undefined && resolveAttachment !== undefined) {
          const ref = block.text.slice(IMAGE_REF_PREFIX.length);
          const attachment = await resolveAttachment(sessionId, ref);
          if (attachment !== undefined) {
            parts.push({
              type: "image",
              mimeType: attachment.mimeType,
              data: Buffer.from(attachment.data).toString("base64"),
            });
            continue;
          }
        }
        parts.push({ type: "text", text: block.text });
      }
      out.push({
        role: "user",
        content: parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts,
        timestamp: Date.now(),
      });
      continue;
    }
    if (msg.role === "assistant") {
      const content: PiAssistantMessage["content"] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "reasoning") {
          content.push({ type: "thinking", thinking: block.text });
        } else if (block.type === "tool-call") {
          toolNames.set(block.id, block.name);
          let parsedArgs: JsonObject = {};
          try {
            const parsed = JSON.parse(block.arguments || "{}");
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              parsedArgs = parsed as JsonObject;
            }
          } catch {
            // Preserve empty args if malformed JSON was persisted.
          }
          content.push({
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: parsedArgs,
          } satisfies PiToolCall);
        }
      }
      out.push({
        role: "assistant",
        content,
        api: "pi-ai",
        provider: msg.source.provider,
        model: msg.source.model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
      continue;
    }
    if (msg.role === "tool") {
      const toolCallId = msg.toolCallId;
      const text = extractText(msg.content);
      const toolResult: PiToolResultMessage = {
        role: "toolResult",
        toolCallId,
        toolName: toolNames.get(toolCallId) ?? "tool",
        content: [{ type: "text", text }],
        isError: msg.isError === true,
        timestamp: Date.now(),
      };
      out.push(toolResult);
    }
  }
  return out;
}

/**
 * Bridges a `@earendil-works/pi-ai` `Models` registry into DSH's `LlmRuntime`.
 */
export class PiAiModelsAdapter extends LlmAdapter {
  private readonly models: Models;
  private readonly hooks: PiAiAdapterHooks;

  constructor(models: Models, hooks: PiAiAdapterHooks = {}) {
    super();
    this.models = models;
    this.hooks = hooks;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const found = this.models.getProvider(provider);
    return {
      id: provider,
      name: found?.name ?? provider,
    };
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.models.getModels(provider).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name || model.id,
    }));
  }

  override async resolveModel(provider: string, modelId: string): Promise<LlmResolvedModelInfo> {
    const found = this.models.getModel(provider, modelId);
    return {
      provider,
      id: modelId,
      name: found?.name ?? modelId,
      ...(found?.contextWindow !== undefined ? { context: { contextWindow: found.contextWindow } } : {}),
      reasoning: {
        efforts: (["minimal", "low", "medium", "high", "xhigh", "max"] as const).map((id) => ({
          id: id as ReasoningEffortId,
          name: id,
        })),
      },
    };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = this.models.getModel(options.provider, options.model);
    if (model === undefined) {
      throw new LlmError(`Model "${options.provider}/${options.model}" is not available`, "UNKNOWN_MODEL");
    }
    const auth = await this.models.getAuth(model);
    if (auth === undefined) {
      throw new LlmError(`Provider "${options.provider}" has no credential`, "AUTH", { status: 401 });
    }

    const piMessages = await toPiMessages(
      options.messages,
      options.system,
      options.sessionId,
      this.hooks.resolveAttachment,
    );
    const piTools: PiTool[] | undefined = options.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as PiTool["parameters"],
    }));
    const context: PiContext = {
      messages: piMessages,
      ...(piTools !== undefined && piTools.length > 0 ? { tools: piTools } : {}),
    };

    let finishSpan: ((err?: unknown) => void) | undefined;
    let spanDone: Promise<void> | undefined;
    let stepSpan: DshTelemetrySpan | undefined;
    if (this.hooks.telemetry !== undefined) {
      const telemetry = this.hooks.telemetry;
      const spanReady = new Promise<DshTelemetrySpan>((resolveReady) => {
        spanDone = telemetry
          .startSpan(
            {
              name: "fastagent.dsh.step",
              attributes: {
                harness: "dsh",
                ...(options.sessionId !== undefined ? { "session.id": options.sessionId } : {}),
              },
            },
            (span) =>
              new Promise<void>((resolveSpan, rejectSpan) => {
                finishSpan = (err) => (err === undefined ? resolveSpan() : rejectSpan(err));
                resolveReady(span);
              }),
          )
          .catch(() => {});
      });
      stepSpan = await spanReady;
    }

    let streamError: unknown;
    try {
      const eventStream = this.models.streamSimple(model, context, {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(toPiReasoning(options.reasoningEffort) !== undefined
          ? { reasoning: toPiReasoning(options.reasoningEffort) }
          : {}),
        ...(stepSpan !== undefined ? { telemetry: stepSpan as never } : {}),
      });

      const toolCallIds = new Map<number, { id: ReturnType<typeof ToolCallId>; name: string }>();

      for await (const event of eventStream) {
        switch (event.type) {
          case "text_start":
            yield { type: "block-start", index: event.contentIndex, blockType: "text" };
            break;
          case "text_delta":
            yield { type: "text-delta", index: event.contentIndex, text: event.delta };
            break;
          case "text_end":
            yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } };
            break;
          case "thinking_start":
            yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
            break;
          case "thinking_delta":
            yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
            break;
          case "thinking_end":
            yield {
              type: "block-end",
              index: event.contentIndex,
              block: { type: "reasoning", text: event.content },
            };
            break;
          case "toolcall_start": {
            const part = event.partial.content[event.contentIndex];
            const rawId = part?.type === "toolCall" && part.id ? part.id : `call_${event.contentIndex}`;
            const name = part?.type === "toolCall" ? part.name : "";
            const callId = ToolCallId(rawId);
            toolCallIds.set(event.contentIndex, { id: callId, name });
            yield { type: "block-start", index: event.contentIndex, blockType: "tool-call" };
            if (name) {
              yield { type: "tool-call-delta", index: event.contentIndex, id: callId, name, argumentsDelta: "" };
            }
            break;
          }
          case "toolcall_delta": {
            const meta = toolCallIds.get(event.contentIndex);
            const part = event.partial.content[event.contentIndex];
            const callId =
              meta?.id ?? ToolCallId(part?.type === "toolCall" && part.id ? part.id : `call_${event.contentIndex}`);
            const name = meta?.name || (part?.type === "toolCall" ? part.name : undefined);
            if (meta === undefined && name !== undefined) toolCallIds.set(event.contentIndex, { id: callId, name });
            yield {
              type: "tool-call-delta",
              index: event.contentIndex,
              id: callId,
              ...(name !== undefined ? { name } : {}),
              argumentsDelta: event.delta,
            };
            break;
          }
          case "toolcall_end": {
            const callId = ToolCallId(event.toolCall.id);
            yield {
              type: "block-end",
              index: event.contentIndex,
              block: {
                type: "tool-call",
                id: callId,
                name: event.toolCall.name,
                arguments: JSON.stringify(event.toolCall.arguments ?? {}),
              },
            };
            break;
          }
          case "done": {
            const u = event.message.usage;
            const usage: TokenUsage = {
              inputTokens: u.input,
              outputTokens: u.output,
              ...(u.totalTokens > 0 ? { totalTokens: u.totalTokens } : {}),
              ...(u.cacheRead > 0 ? { cacheReadTokens: u.cacheRead } : {}),
              ...(u.cacheWrite > 0 ? { cacheWriteTokens: u.cacheWrite } : {}),
            };
            if (u.cost.total > 0) {
              this.hooks.onCallCost?.(options.sessionId, {
                provider: options.provider,
                modelId: options.model,
                cost: u.cost.total,
              });
            }
            yield { type: "usage", usage };
            const reason =
              event.reason === "toolUse"
                ? ({ kind: "tool-calls" } as const)
                : event.reason === "length"
                  ? ({ kind: "max-tokens" } as const)
                  : ({ kind: "stop" } as const);
            yield { type: "finish", reason };
            return;
          }
          case "error": {
            const errMessage = event.error.errorMessage || "Model call failed";
            if (event.reason === "aborted") {
              yield {
                type: "finish",
                reason: { kind: "aborted", failure: { message: errMessage, code: "ABORTED" } },
              };
              return;
            }
            const classified = classifyPiError(errMessage);
            throw new LlmError(
              errMessage,
              classified.code,
              classified.status ? { status: classified.status } : undefined,
            );
          }
        }
      }
    } catch (error) {
      streamError = error;
      throw error;
    } finally {
      finishSpan?.(streamError);
      await spanDone;
    }
  }
}
