/**
 * Tool bridge from FastAgent's harness-neutral `defineTool` (JSON Schema / Standard Schema v1) into DSH's
 * `@deepseek-ai/dsh-tools` registration contract (`output: { schema, render }`).
 */
import type { DshToolDefinition, FastAgentToolLike } from "./types.ts";

const TOOL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    text: { type: "string" },
    isError: { type: "boolean" },
  },
  required: ["text"],
};

/**
 * Convert a FastAgent tool registration into a DSH `ToolDefinition`.
 * Preserves JSON Schema parameters verbatim and forwards DSH's `exec.signal` as the tool's abort signal.
 */
export function toDshToolDefinition(tool: FastAgentToolLike): DshToolDefinition {
  if (!tool.name || typeof tool.name !== "string") {
    throw new Error("DSH tool bridge requires a non-empty tool name");
  }
  if (
    tool.parameters !== null &&
    (typeof tool.parameters === "object" || typeof tool.parameters === "function") &&
    "~standard" in tool.parameters
  ) {
    throw new Error(
      `DSH tool "${tool.name}" received an unconverted Standard Schema; wrap it with defineTool from "@fastagent-sh/fastagent"`,
    );
  }
  if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
    throw new Error(`DSH tool "${tool.name}" requires an object JSON Schema for parameters`);
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters) as Record<string, unknown>,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (value: unknown) => {
        const text =
          typeof value === "object" &&
          value !== null &&
          "text" in value &&
          typeof (value as { text?: unknown }).text === "string"
            ? (value as { text: string }).text
            : JSON.stringify(value);
        return [{ type: "text", text }];
      },
    },
    async execute(args: unknown, exec: { readonly signal: AbortSignal }) {
      const input =
        typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      const result = await (
        tool.execute as (
          args: Record<string, unknown>,
          api: Record<string, unknown>,
          context: { abortSignal: AbortSignal },
        ) => Promise<{
          readonly output?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
          readonly isError?: boolean;
        }>
      )(input, {}, { abortSignal: exec.signal });
      const text = (result.output ?? [])
        .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : JSON.stringify(part)))
        .join("\n");
      return {
        text,
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
  };
}
