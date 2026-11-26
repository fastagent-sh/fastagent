/**
 * Command expansion and DSH content block conversion helpers for `@fastagent-sh/harness-dsh`.
 */
import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type { ContentBlock, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import {
  type ContentPart,
  type ModelRef,
  type SendRequest,
  type ThinkingLevel,
  agentError,
} from "@fastagent-sh/client/agent-api";
import type { AgentCommand } from "@fastagent-sh/fastagent/harness";
import { IMAGE_REF_PREFIX } from "./llm-pi-ai.ts";

export const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function expandCommandText(text: string, commands: readonly AgentCommand[]): string {
  if (!text.startsWith("/")) return text;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return text;
  const [, name, rest = ""] = match;
  const command = commands.find((candidate) => candidate.name === name);
  return command === undefined ? text : command.expand(rest);
}

export function normalizeSendContent(
  content: SendRequest["content"],
  commands: readonly AgentCommand[],
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
