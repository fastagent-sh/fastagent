import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mcpGrantFile } from "../../../src/mcp/grants.ts";
import { grantToken } from "../../../src/mcp/auth.ts";
import { mcpFetch } from "../../../src/mcp/network.ts";
import { signInMcp } from "../../../src/mcp/sign-in.ts";
import { inspectMcp } from "../../../src/mcp/host.ts";
import type { McpGrantStore } from "../../../src/mcp-api.ts";
import { mcpFixture } from "./mcp-fixture.ts";
let dir: string;
let file: string;
let store: McpGrantStore;
let remote: ReturnType<typeof mcpFixture>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-auth-"));
  file = join(dir, "grants.json");
  store = mcpGrantFile(file);
  remote = mcpFixture();
  await writeFile(
    join(dir, "context.json"),
    JSON.stringify({ mcpServers: { linear: { type: "http", url: remote.url } } }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const token = (store: McpGrantStore, id: string, rejectedGeneration?: number) =>
  grantToken({ store, id, url: remote.url, fetch: mcpFetch(remote.url, remote.fetch), rejectedGeneration });

it("validates the grant target before sending a token", async () => {
  await store.withGrant("one", (tx) => tx.write({ ...remote.grant(), serverUrl: "https://other.test/mcp" }));
  await expect(token(store, "one")).rejects.toMatchObject({ code: "authorization_mismatch" });
  expect(remote.refreshes).toBe(0);
});
it("signs in with PKCE and stores before returning, without choosing an agent binding", async () => {
  const callbacks: Promise<Response>[] = [];
  const result = await signInMcp({
    agentDir: dir,
    server: "linear",
    store,
    fetch: remote.fetch,
    scopes: ["read"],
    interaction: {
      confirmAuthorization: async (request) => {
        expect(request.scopes).toEqual(["read"]);
        return true;
      },
      notify: (event) => {
        if (event.type === "auth_url") callbacks.push(remote.approve(event.url));
      },
    },
  });
  const response = await callbacks[0];
  expect(response?.status).toBe(200);
  expect(remote.exchanges).toBe(1);
  expect((await store.read(result.id))?.status).toBe("ready");
  expect(JSON.stringify(result)).not.toMatch(/accessToken|refreshToken/);
  expect(await inspectMcp(dir, { store, bindings: {} })).toMatchObject([{ authorization: "not_bound" }]);
});
it("refuses a wrong state without consuming the valid callback", async () => {
  const callbacks: Promise<Response>[] = [];
  const run = signInMcp({
    agentDir: dir,
    server: "linear",
    store,
    fetch: remote.fetch,
    interaction: {
      confirmAuthorization: async () => true,
      notify: (event) => {
        if (event.type === "auth_url")
          callbacks.push(
            (async () => {
              const bad = await remote.approve(event.url, { wrongState: true });
              expect(bad.status).toBe(400);
              expect(remote.exchanges).toBe(0);
              return remote.approve(event.url);
            })(),
          );
      },
    },
  });
  const summary = await run;
  await Promise.all(callbacks);
  expect(await store.read(summary.id)).toBeDefined();
});
