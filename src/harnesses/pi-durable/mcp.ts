/** MCP tools on pi-durable. No replay promise is inferred from a server's annotations. */
import { Type, type JsonObject } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { McpTool } from "../../mcp/client.ts";
import { McpError } from "../../mcp-api.ts";

export function mcpTools(tools: readonly McpTool[]): ToolRegistration[] {
  return tools.map((tool) =>
    defineTool({
      name: tool.name,
      description: tool.definition.description ?? `MCP tool ${tool.definition.name} from ${tool.server}`,
      parameters: Type.Unsafe<JsonObject>(tool.definition.inputSchema),
      replay: "unsafe",
      execute: async (args, api, context) => {
        try {
          const result = await tool.call(args, context.abortSignal, (text) => api.output(text));
          if (result.content.some((part) => part.type !== "text"))
            throw new McpError(
              "protocol",
              "MCP tool returned unsupported content; only text/JSON is supported",
              tool.server,
            );
          const output = result.content.flatMap((part) =>
            part.type === "text" ? [{ type: "text" as const, text: part.text }] : [],
          );
          if (result.structuredContent !== undefined)
            output.push({ type: "text", text: JSON.stringify(result.structuredContent) });
          return { output, ...(result.isError ? { isError: true } : {}) };
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          if (!(error instanceof McpError)) throw error;
          // Preserve actionable auth/connection classification in the existing tool-result details.
          return {
            output: [{ type: "text", text: error.message }],
            isError: true,
            details: { mcp: { server: tool.server, code: error.code } },
          };
        }
      },
    }),
  );
}
