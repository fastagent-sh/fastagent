import { rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { openMcpClients } from "../../../src/mcp/client.ts";
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
