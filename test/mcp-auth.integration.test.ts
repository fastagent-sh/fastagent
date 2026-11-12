import { grantToken } from "../src/mcp/auth.ts";
import { mcpFetch } from "../src/mcp/network.ts";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mcpGrantFile } from "../src/mcp/grants.ts";
import type { McpGrantStore } from "../src/mcp-api.ts";
import { mcpFixture } from "./mcp-fixture.ts";
let dir: string;
let file: string;
let store: McpGrantStore;
let remote: ReturnType<typeof mcpFixture>;
const token = (store: McpGrantStore, id: string, rejectedGeneration?: number) =>
  grantToken({ store, id, url: remote.url, fetch: mcpFetch(remote.url, remote.fetch), rejectedGeneration });
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

it("recovers the durable fence after a real process is killed during rotation", async () => {
  const rotated = Promise.withResolvers<void>();
  const responseReady = Promise.withResolvers<void>();
  const server = createServer(
    getRequestListener(
      async (request) => {
        const response = await remote.fetch(request.url, {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }),
        });
        if (new URL(request.url).pathname === "/token") {
          rotated.resolve();
          await responseReady.promise;
        }
        return response;
      },
      { overrideGlobalObjects: false },
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  remote = mcpFixture(`http://127.0.0.1:${address.port}`);
  await store.withGrant("one", (tx) => tx.write(remote.grant()));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { mcpGrantFile } from ${JSON.stringify(new URL("../src/mcp/grants.ts", import.meta.url).href)};
    import { grantToken } from ${JSON.stringify(new URL("../src/mcp/auth.ts", import.meta.url).href)};
    import { openMcpNetwork, mcpFetch } from ${JSON.stringify(new URL("../src/mcp/network.ts", import.meta.url).href)};
    const network=await openMcpNetwork(${JSON.stringify(remote.url)});
    try { await grantToken({store:mcpGrantFile(${JSON.stringify(file)}),id:"one",url:${JSON.stringify(remote.url)},fetch:mcpFetch(${JSON.stringify(remote.url)},network.fetch)}); }
    finally { await network.close(); }
  `,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      rotated.promise,
      exited.then(() => {
        throw new Error(`refresh process exited early: ${stderr}`);
      }),
    ]);
    child.kill("SIGKILL");
    expect(await exited).toEqual([null, "SIGKILL"]);
    responseReady.resolve();
    expect((await store.read("one"))?.status).toBe("refreshing");
    // Age the orphaned lease instead of waiting for the real 30-second stale window.
    const stale = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, stale, stale);
    await expect(token(mcpGrantFile(file), "one")).rejects.toMatchObject({ code: "refresh_uncertain" });
    expect(remote.refreshes).toBe(1);
  } finally {
    child.kill("SIGKILL");
    await exited;
    responseReady.resolve();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
