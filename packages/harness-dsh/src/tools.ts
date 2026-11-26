/**
 * Tool bridge from FastAgent's harness-neutral `defineTool` (JSON Schema / Standard Schema v1) into DSH's
 * `@deepseek-ai/dsh-tools` registration contract (`output: { schema, render, presentationMeta }`).
 */
import type { ToolDefinition as DshRuntimeToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { DshTelemetryContext, FastAgentToolApi, FastAgentToolLike } from "./types.ts";

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
  readonly telemetry?: DshTelemetryContext;
}

function retainOutput(
  buffer: string,
  limits?: { readonly maxBytes?: number; readonly maxLines?: number; readonly retain?: "head" | "tail" },
): string {
  let out = buffer;
  if (limits?.maxLines !== undefined && limits.maxLines > 0) {
    const lines = out.split("\n");
    if (lines.length > limits.maxLines) {
      out = (limits.retain === "head" ? lines.slice(0, limits.maxLines) : lines.slice(-limits.maxLines)).join("\n");
    }
  }
  if (limits?.maxBytes === undefined || limits.maxBytes <= 0) return out;
  const bytes = Buffer.from(out, "utf8");
  if (bytes.byteLength <= limits.maxBytes) return out;
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

export function validateFastAgentTool(tool: FastAgentToolLike): void {
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
        async executeTool(
          nestedName: string,
          nestedArgs: unknown,
          context?: { readonly abortSignal?: AbortSignal; readonly sessionId?: string },
        ) {
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
          const effectiveSessionId = context?.sessionId ?? sessionId;
          return (
            target.execute as (
              args: Record<string, unknown>,
              api: FastAgentToolApi,
              context: { abortSignal: AbortSignal; sessionId?: string },
            ) => Promise<unknown>
          )(nestedInput, api, {
            abortSignal: context?.abortSignal ?? exec.signal,
            ...(effectiveSessionId !== undefined ? { sessionId: effectiveSessionId } : {}),
          });
        },
      };

      const runTool = async () => {
        const result = await (
          tool.execute as (
            args: Record<string, unknown>,
            api: FastAgentToolApi,
            context: { abortSignal: AbortSignal; sessionId?: string },
          ) => Promise<{
            readonly output?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
            readonly details?: unknown;
            readonly isError?: boolean;
            readonly control?: { readonly terminate?: boolean };
          }>
        )(input, api, { abortSignal: exec.signal, ...(sessionId !== undefined ? { sessionId } : {}) });

        if (result?.control?.terminate === true) exec.concludeTurn();
        const explicitText = extractResultText(result);
        const text = explicitText.length > 0 ? explicitText : streamedOutput.trimEnd();
        if (result?.isError === true) {
          throw new Error(text || "Tool execution failed");
        }
        return {
          text,
          ...(result?.details !== undefined ? { details: structuredClone(result.details) } : {}),
        };
      };

      if (runtime.telemetry === undefined) return runTool();
      return runtime.telemetry.startSpan(
        {
          name: "fastagent.dsh.tool",
          attributes: {
            harness: "dsh",
            "tool.name": tool.name,
            ...(sessionId !== undefined ? { "session.id": sessionId } : {}),
          },
        },
        async (span) => {
          try {
            return await runTool();
          } catch (error) {
            span.setStatus({ status: "error", error: { name: "ToolError", message: "tool execution failed" } });
            throw error;
          }
        },
      );
    },
  };
}
