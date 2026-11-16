/** A real MCP protocol handler behind a static bearer token, reached through a `fetch` stand-in: no network. */
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";

export const MCP_FIXTURE_TOKEN = "fixture-token";

export function mcpFixture() {
  const url = "https://mcp.test/mcp";
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "fixture", version: "1" });
      server.registerTool(
        "echo",
        {
          inputSchema: fromJsonSchema<{ text: string }>({
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          }),
        },
        async ({ text }) => ({ content: [{ type: "text", text }] }),
      );
      return server;
    },
    { legacy: "reject" },
  );
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    if (request.url !== url) return new Response("not found", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${MCP_FIXTURE_TOKEN}`) {
      return new Response(null, { status: 401 });
    }
    return handler.fetch(request);
  };
  return { url, fetch };
}
