import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpClients } from "../src/mcp/client.ts";
import { mcpGrantFile } from "../src/mcp/grants.ts";
import { mcpFixture } from "./mcp-fixture.ts";

export const roots: string[] = [];

export const clients: McpClients[] = [];

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-client-"));
  roots.push(root);
  const remote = mcpFixture();
  const store = mcpGrantFile(join(root, "grants.json"));
  const record = remote.grant("one", false);
  await store.withGrant("g", (tx) => tx.write(record));
  const auth = { store, bindings: { server: "g" } };
  const servers = [{ name: "server", type: "http" as const, url: remote.url, headers: {} }];
  return { remote, store, record, auth, servers };
}
