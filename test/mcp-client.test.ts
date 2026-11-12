import { rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { openMcpClients } from "../src/mcp/client.ts";
import { roots, clients, fixture } from "./mcp-client-fixtures.ts";
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("reports required authorization instead of trying to open a browser", async () => {
  const { remote, store, servers } = await fixture();
  await expect(openMcpClients(servers, { store, bindings: {} }, { fetch: remote.fetch })).rejects.toMatchObject({
    code: "authorization_required",
    server: "server",
  });
  expect(remote.approvals).toBe(0);
});
it("handles an explicit 401 with one refresh and preserves validation of the tool arguments", async () => {
  const { remote, record, auth, servers } = await fixture();
  const client = await openMcpClients(servers, auth, { fetch: remote.fetch });
  clients.push(client);
  remote.invalidate(record.accessToken);
  const echo = client.tools.find((tool) => tool.definition.name === "echo");
  if (!echo) throw new Error("no echo");
  expect((await echo.call({ text: "ok" })).content).toEqual([{ type: "text", text: "ok" }]);
  expect(remote.refreshes).toBe(1);
  await expect(echo.call({ other: "invalid" })).resolves.toMatchObject({ isError: true });
});
it("does not refresh or escalate scopes after a 403", async () => {
  const { remote, auth, servers } = await fixture();
  let forbidden = false;
  const fetch: typeof globalThis.fetch = async (input, init) =>
    forbidden && String(input) === remote.url
      ? new Response(null, {
          status: 403,
          headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="write"' },
        })
      : remote.fetch(input, init);
  const client = await openMcpClients(servers, auth, { fetch });
  clients.push(client);
  forbidden = true;
  await expect(client.tools[0]?.call({ text: "no" })).rejects.toMatchObject({ code: "insufficient_scope" });
  expect(remote.refreshes).toBe(0);
  expect(remote.approvals).toBe(0);
});
it("refuses a server without tool capability rather than opening an empty integration", async () => {
  const { remote, auth, servers } = await fixture();
  remote.offersTools = false;
  await expect(openMcpClients(servers, auth, { fetch: remote.fetch })).rejects.toMatchObject({ code: "protocol" });
});

it("refuses duplicate tool names from a server", async () => {
  const { remote, auth, servers } = await fixture();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if (body?.method === "tools/list") {
      const reply = (await (await remote.fetch(input, init)).json()) as { result: { tools: object[] } };
      reply.result.tools = [reply.result.tools[0] as object, reply.result.tools[0] as object];
      return Response.json(reply);
    }
    return remote.fetch(input, init);
  };
  await expect(openMcpClients(servers, auth, { fetch })).rejects.toMatchObject({ code: "configuration" });
});
