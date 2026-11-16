import { afterEach, expect, it } from "vitest";
import { type McpClients, openMcpClients } from "../../../src/mcp/client.ts";
import { MCP_FIXTURE_TOKEN, mcpFixture } from "./mcp-fixture.ts";

const clients: McpClients[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

const server = (url: string, token: string) => ({
  name: "server",
  type: "http" as const,
  url,
  headers: { Authorization: `Bearer ${token}` },
});

it("reaches an HTTP server with the headers its declaration names, and calls its tools", async () => {
  const remote = mcpFixture();
  const opened = await openMcpClients([server(remote.url, MCP_FIXTURE_TOKEN)], remote.fetch);
  clients.push(opened);
  const [echo] = opened.tools;
  expect(echo?.name).toBe("mcp__server__echo");
  expect((await echo?.call({ text: "hi" }))?.content).toEqual([{ type: "text", text: "hi" }]);
});

it("refuses a server that refuses its credentials, saying so without the credential", async () => {
  const remote = mcpFixture();
  const refused: unknown = await openMcpClients([server(remote.url, "wrong-token")], remote.fetch).catch(
    (error: unknown) => error,
  );
  expect(refused).toMatchObject({ code: "authorization_required", server: "server" });
  expect((refused as Error).message).toMatch(/refused the request \(HTTP 401\)/);
  expect((refused as Error).message).not.toContain("wrong-token");
});
