/**
 * Pure request validation, command expansion, and content conversion helpers for `@fastagent-sh/harness-dsh`.
 */
import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type { ContentBlock, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import {
  type ContentPart,
  type Metadata,
  type ModelRef,
  type SendRequest,
  type ThinkingLevel,
  agentError,
} from "@fastagent-sh/client/agent-api";
import { IMAGE_REF_PREFIX } from "./llm-pi-ai.ts";
import type { DshCommand } from "./types.ts";

const VALID_THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function decodeMetadata(metadata: unknown): Metadata | undefined {
  if (metadata === undefined) return undefined;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw agentError("invalid_request", "metadata must be a string record");
  }
  const entries = Object.entries(metadata);
  if (entries.length > 16) {
    throw agentError("invalid_request", "metadata may contain at most 16 keys");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.length < 1 || key.length > 64) {
      throw agentError("invalid_request", "a metadata key must be 1 to 64 characters");
    }
    if (typeof value !== "string" || value.length > 512) {
      throw agentError("invalid_request", "each metadata value must be a string of at most 512 characters");
    }
    out[key] = value;
  }
  return out;
}

export function decodeIdempotencyKey(key: unknown): string | undefined {
  if (key === undefined) return undefined;
  if (typeof key !== "string" || key.length < 1 || key.length > 256) {
    throw agentError("invalid_request", "idempotencyKey must be 1 to 256 characters");
  }
  return key;
}

export function validateTitle(title: unknown): string {
  if (typeof title !== "string" || title.length < 1 || title.length > 200) {
    throw agentError("invalid_request", "session title must be 1 to 200 characters");
  }
  return title;
}

export function validateThinkingLevel(level: unknown): ThinkingLevel {
  if (typeof level !== "string" || !VALID_THINKING_LEVELS.has(level)) {
    throw agentError("invalid_request", `invalid thinkingLevel: ${String(level)}`);
  }
  return level as ThinkingLevel;
}

export function validateWait(wait: number | undefined): void {
  if (wait !== undefined && (typeof wait !== "number" || Number.isNaN(wait) || wait < 0)) {
    throw agentError("invalid_request", `wait must be a non-negative number, got ${String(wait)}`);
  }
}

function expandCommandText(text: string, commands: readonly DshCommand[]): string {
  if (!text.startsWith("/")) return text;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return text;
  const [, name, rest = ""] = match;
  const command = commands.find((candidate) => candidate.name === name);
  return command === undefined ? text : command.expand(rest);
}

export function normalizeSendContent(
  content: SendRequest["content"],
  commands: readonly DshCommand[],
): {
  readonly rawParts: readonly ContentPart[];
  readonly expandedParts: readonly ContentPart[];
} {
  if (typeof content === "string") {
    if (content.length === 0) {
      throw agentError("invalid_request", "message content must not be empty");
    }
    const expanded = expandCommandText(content, commands);
    return {
      rawParts: [{ type: "text", text: content }],
      expandedParts: [{ type: "text", text: expanded }],
    };
  }
  if (!Array.isArray(content) || content.length === 0) {
    throw agentError("invalid_request", "message content must contain at least one part");
  }
  const rawParts: ContentPart[] = [];
  const expandedParts: ContentPart[] = [];
  let expandedFirstText = false;
  for (const part of content) {
    if (part.type === "text") {
      rawParts.push({ type: "text", text: part.text });
      if (!expandedFirstText) {
        expandedFirstText = true;
        expandedParts.push({ type: "text", text: expandCommandText(part.text, commands) });
      } else {
        expandedParts.push({ type: "text", text: part.text });
      }
    } else if (part.type === "image" && "data" in part) {
      rawParts.push(part);
      expandedParts.push(part);
    } else {
      throw agentError("invalid_request", "unsupported content part");
    }
  }
  return { rawParts, expandedParts };
}

export function toDshBlocks(parts: readonly ContentPart[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image" && "ref" in part) {
      blocks.push({ type: "text", text: `${IMAGE_REF_PREFIX}${part.ref}` });
    }
  }
  return blocks;
}

export function makeAgentOptions(model: ModelRef | undefined, thinkingLevel: ThinkingLevel | undefined): AgentOptions {
  return {
    ...(model !== undefined ? { provider: model.provider, model: model.modelId } : {}),
    ...(thinkingLevel !== undefined ? { reasoningEffort: thinkingLevel as ReasoningEffortId } : {}),
  };
}
