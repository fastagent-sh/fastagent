/** The MCP error an embedding host sees. No SDK or harness types cross this boundary. */
export type McpErrorCode = "configuration" | "authorization_required" | "connection" | "protocol";

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly server?: string | undefined;
  constructor(code: McpErrorCode, message: string, server?: string) {
    super(server ? `${server}: ${message}` : message);
    this.name = "McpError";
    this.code = code;
    this.server = server;
  }
}
