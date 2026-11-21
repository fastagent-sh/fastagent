/**
 * Tool bridge from FastAgent's harness-neutral `defineTool` (JSON Schema / Standard Schema v1) into DSH's
 * `@deepseek-ai/dsh-tools` registration contract (`output: { schema, render, presentationMeta }`).
 */
import type { ToolDefinition as DshRuntimeToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { DshToolDefinition, FastAgentToolApi, FastAgentToolLike } from "./types.ts";

type DshPresentationMeta = ReturnType<NonNullable<DshRuntimeToolDefinition["output"]["presentationMeta"]>>;

const TOOL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    text: { type: "string" },
    isError: { type: "boolean" },
  },
  required: ["text"],
  additionalProperties: true,
};

interface ToolProgressEvent {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly text: string;
  readonly output?: string;
}

export interface ToolBridgeRuntime {
  readonly toolsByName: ReadonlyMap<string, FastAgentToolLike>;
  readonly onProgress: (event: ToolProgressEvent) => void;
}

function retainOutput(
  buffer: string,
  limits?: { readonly maxBytes?: number; readonly retain?: "head" | "tail" },
): string {
  if (limits?.maxBytes === undefined || limits.maxBytes <= 0) return buffer;
  const bytes = Buffer.from(buffer, "utf8");
  if (bytes.byteLength <= limits.maxBytes) return buffer;
  if (limits.retain === "head") return bytes.subarray(0, limits.maxBytes).toString("utf8");
  return bytes.subarray(bytes.byteLength - limits.maxBytes).toString("utf8");
}

function formatNestedCall(name: string, args: unknown): string {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const values = Object.values(args).filter((v) => typeof v === "string" || typeof v === "number");
    if (values.length > 0) return `${name} ${values.map(String).join(" ")}`;
  }
  return name;
}

function validateFastAgentTool(tool: FastAgentToolLike): void {
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
}

function renderToolOutput(_args: unknown, value: unknown): Array<{ readonly type: "text"; readonly text: string }> {
  const text =
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof (value as { text?: unknown }).text === "string"
      ? (value as { text: string }).text
      : JSON.stringify(value);
  return [{ type: "text", text }];
}

function extractResultText(
  result: { readonly output?: ReadonlyArray<{ readonly type: string; readonly text?: string }> } | undefined,
): string {
  return (result?.output ?? [])
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : JSON.stringify(part)))
    .join("\n");
}

/**
 * Convert a FastAgent tool registration into a DSH `ToolDefinition`.
 * Preserves JSON Schema parameters verbatim and forwards DSH's `exec.signal` as the tool's abort signal.
 */
export function toDshToolDefinition(tool: FastAgentToolLike): DshToolDefinition {
  validateFastAgentTool(tool);
  return {
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters) as Record<string, unknown>,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (argsOrValue: unknown, maybeValue?: unknown) =>
        renderToolOutput(maybeValue === undefined ? undefined : argsOrValue, maybeValue ?? argsOrValue),
      presentationMeta: (_args: unknown, value: unknown) =>
        typeof value === "object" && value !== null && "details" in value
          ? (value as { details?: unknown }).details
          : undefined,
    },
    async execute(args: unknown, exec: { readonly signal: AbortSignal; concludeTurn?(): void }) {
      const input =
        typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      const result = await (
        tool.execute as (
          args: Record<string, unknown>,
          api: FastAgentToolApi,
          context: { abortSignal: AbortSignal },
        ) => Promise<{
          readonly output?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
          readonly details?: unknown;
          readonly isError?: boolean;
          readonly control?: { readonly terminate?: boolean };
        }>
      )(input, {}, { abortSignal: exec.signal });
      if (result?.control?.terminate === true) exec.concludeTurn?.();
      const text = extractResultText(result);
      return {
        text,
        ...(result?.isError === true ? { isError: true } : {}),
        ...(result?.details !== undefined ? { details: structuredClone(result.details) } : {}),
      };
    },
  };
}

/**
 * Bridge a FastAgent tool for live DSH execution with streaming `api.output()` progress,
 * nested `api.executeTool()` attribution on the outer `toolCallId`, `details` persistence,
 * and `control.terminate` -> `exec.concludeTurn()`.
 */
export function bridgeDshRuntimeTool(tool: FastAgentToolLike, runtime: ToolBridgeRuntime): DshRuntimeToolDefinition {
  validateFastAgentTool(tool);
  return {
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters) as Record<string, unknown>,
    output: {
      schema: TOOL_OUTPUT_SCHEMA as DshRuntimeToolDefinition["output"]["schema"],
      render: (args, value) => renderToolOutput(args, value),
      presentationMeta: (_args, value): DshPresentationMeta => {
        if (typeof value === "object" && value !== null && "details" in value) {
          const details = (value as { details?: unknown }).details;
          if (details !== undefined) return structuredClone(details) as DshPresentationMeta;
        }
        return null;
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const input =
        typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      const sessionId = exec.agent?.id;
      const toolCallId = String(exec.callId);
      let streamedOutput = "";
      let lastReportedLine = "";

      const api: FastAgentToolApi = {
        output(chunk: string) {
          streamedOutput = retainOutput(streamedOutput + chunk, tool.outputLimits);
          if (sessionId === undefined) return;
          const nonEmpty = streamedOutput
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          const latest = nonEmpty.at(-1);
          if (latest !== undefined && latest !== lastReportedLine) {
            lastReportedLine = latest;
            runtime.onProgress({
              sessionId,
              toolCallId,
              text: latest,
              ...(nonEmpty.length > 1 ? { output: streamedOutput.trimEnd() } : {}),
            });
          }
        },
        async executeTool(nestedName: string, nestedArgs: unknown, context?: { readonly abortSignal?: AbortSignal }) {
          const target = runtime.toolsByName.get(nestedName);
          if (target === undefined) throw new Error(`Unknown tool: ${nestedName}`);
          if (sessionId !== undefined) {
            runtime.onProgress({
              sessionId,
              toolCallId,
              text: formatNestedCall(nestedName, nestedArgs),
            });
          }
          const nestedInput =
            typeof nestedArgs === "object" && nestedArgs !== null && !Array.isArray(nestedArgs)
              ? (nestedArgs as Record<string, unknown>)
              : {};
          return (
            target.execute as (
              args: Record<string, unknown>,
              api: FastAgentToolApi,
              context: { abortSignal: AbortSignal },
            ) => Promise<unknown>
          )(nestedInput, api, { abortSignal: context?.abortSignal ?? exec.signal });
        },
      };

      const result = await (
        tool.execute as (
          args: Record<string, unknown>,
          api: FastAgentToolApi,
          context: { abortSignal: AbortSignal },
        ) => Promise<{
          readonly output?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
          readonly details?: unknown;
          readonly isError?: boolean;
          readonly control?: { readonly terminate?: boolean };
        }>
      )(input, api, { abortSignal: exec.signal });

      if (result?.control?.terminate === true) exec.concludeTurn();
      const explicitText = extractResultText(result);
      const text = explicitText.length > 0 ? explicitText : streamedOutput.trimEnd();
      return {
        text,
        ...(result?.isError === true ? { isError: true } : {}),
        ...(result?.details !== undefined ? { details: structuredClone(result.details) } : {}),
      };
    },
  };
}
