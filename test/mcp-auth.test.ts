import { mkdtemp, readFile, rm, stat, writeFile, symlink, readlink, utimes } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mcpGrantFile } from "../src/mcp/grants.ts";
import { grantToken, mcpFetch } from "../src/mcp/auth.ts";
import { signInMcp } from "../src/mcp/sign-in.ts";
import { inspectMcp } from "../src/mcp/host.ts";
import type { McpGrantStore } from "../src/mcp-api.ts";
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
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { linear: { type: "http", url: remote.url } } }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const token = (store: McpGrantStore, id: string, rejectedGeneration?: number) =>
  grantToken({ store, id, url: remote.url, fetch: mcpFetch(remote.fetch), rejectedGeneration });

it("serializes independent store objects and two 401s for the same token generation", async () => {
  await store.withGrant("shared", (tx) => tx.write(remote.grant("one", false)));
  const [a, b] = await Promise.all([token(store, "shared", 0), token(mcpGrantFile(file), "shared", 0)]);
  expect(a).toEqual(b);
  expect(remote.refreshes).toBe(1);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await token(mcpGrantFile(file), "shared")).toEqual(a);
  expect(remote.refreshes).toBe(1);
});
it.each(["file", "directory"])("serializes a grant reached through a %s symlink", async (kind) => {
  await store.withGrant("shared", (tx) => tx.write(remote.grant()));
  const alias = join(dir, "linked");
  await symlink(kind === "file" ? file : dir, alias, kind === "file" ? "file" : "dir");
  const other = mcpGrantFile(kind === "file" ? alias : join(alias, "grants.json"));
  remote.refreshDelay = 150;
  const results = await Promise.allSettled([token(store, "shared"), token(other, "shared")]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(remote.refreshes).toBe(1);
});

it("keeps separate accounts at one endpoint and exposes only summaries", async () => {
  await store.withGrant("one", (tx) => tx.write(remote.grant("one")));
  await store.withGrant("two", (tx) => tx.write(remote.grant("two")));
  const [a, b] = await Promise.all([token(store, "one"), token(store, "two")]);
  expect(a.token).not.toBe(b.token);
  expect(JSON.stringify(await store.list())).not.toMatch(/accessToken|refreshToken|client/);
  expect(await inspectMcp(dir, { store, bindings: { linear: "one" } })).toMatchObject([
    { authorization: "ready", grantId: "one" },
  ]);
});
it("retains a durable fence after network failure and refuses to replay the token", async () => {
  await store.withGrant("one", (tx) => tx.write(remote.grant()));
  remote.networkFailure = true;
  await expect(token(store, "one")).rejects.toMatchObject({ code: "connection" });
  expect((await store.read("one"))?.status).toBe("refreshing");
  await expect(token(mcpGrantFile(file), "one")).rejects.toMatchObject({ code: "refresh_uncertain" });
  expect(remote.refreshes).toBe(1);
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
    import { grantToken, mcpFetch } from ${JSON.stringify(new URL("../src/mcp/auth.ts", import.meta.url).href)};
    await grantToken({store:mcpGrantFile(${JSON.stringify(file)}),id:"one",url:${JSON.stringify(remote.url)},fetch:mcpFetch()});
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

it("does not lose the refresh marker when the successful token cannot be saved", async () => {
  await store.withGrant("one", (tx) => tx.write(remote.grant()));
  const faulty: McpGrantStore = {
    ...store,
    withGrant: (id, body) =>
      store.withGrant(id, (tx) =>
        body({
          ...tx,
          write: async (record) => {
            if (record.generation > 0) throw new Error("disk full");
            await tx.write(record);
          },
        }),
      ),
  };
  await expect(token(faulty, "one")).rejects.toThrow("disk full");
  await expect(token(store, "one")).rejects.toMatchObject({ code: "refresh_uncertain" });
  expect(remote.refreshes).toBe(1);
});
it("orders forgetting after an in-flight refresh", async () => {
  await store.withGrant("one", (tx) => tx.write(remote.grant()));
  remote.refreshDelay = 80;
  const entered = Promise.withResolvers<void>();
  const fetch: typeof globalThis.fetch = async (...args) => {
    if (String(args[0]).endsWith("/token")) entered.resolve();
    return remote.fetch(...args);
  };
  const refresh = grantToken({ store, id: "one", url: remote.url, fetch: mcpFetch(fetch) });
  await entered.promise;
  const forget = store.withGrant("one", (tx) => tx.remove());
  await refresh;
  await forget;
  expect(await store.read("one")).toBeUndefined();
});
it("refuses corrupt files and escaped access without overwriting", async () => {
  await writeFile(file, "broken");
  await expect(store.list()).rejects.toMatchObject({ code: "storage" });
  await expect(store.withGrant("x", (tx) => tx.write(remote.grant()))).rejects.toMatchObject({ code: "storage" });
  expect(await readFile(file, "utf8")).toBe("broken");
  await rm(file);
  const escaped = await store.withGrant("x", async (tx) => tx);
  await expect(escaped.write(remote.grant())).rejects.toMatchObject({ code: "storage" });
});
it("keeps a dangling credential symlink while persisting intermediate grant writes", async () => {
  const targetFile = join(dir, "actual.json");
  await symlink(targetFile, file);
  await store.withGrant("one", async (tx) => {
    await tx.write({ ...remote.grant(), status: "refreshing" });
    expect((await mcpGrantFile(targetFile).read("one"))?.status).toBe("refreshing");
  });
  expect(await readlink(file)).toBe(targetFile);
  expect((await stat(targetFile)).mode & 0o777).toBe(0o600);
});

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
it.each([
  { deny: true, code: "canceled" },
  { wrongIssuer: true, code: "authorization_mismatch" },
])("refuses a browser response without storing a grant: $code", async (scenario) => {
  const callbacks: Promise<Response>[] = [];
  await expect(
    signInMcp({
      agentDir: dir,
      server: "linear",
      store,
      fetch: remote.fetch,
      interaction: {
        confirmAuthorization: async () => true,
        notify: (event) => {
          if (event.type === "auth_url") callbacks.push(remote.approve(event.url, scenario));
        },
      },
    }),
  ).rejects.toMatchObject({ code: scenario.code });
  await Promise.all(callbacks);
  expect(await store.list()).toEqual([]);
  expect(remote.exchanges).toBe(0);
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

it("does not accept expanded scopes during refresh or sign-in", async () => {
  await store.withGrant("one", (tx) => tx.write(remote.grant()));
  remote.expandedScope = true;
  await expect(token(store, "one")).rejects.toMatchObject({ code: "insufficient_scope" });
  expect((await store.read("one"))?.status).toBe("refreshing");
  const callbacks: Promise<Response>[] = [];
  await expect(
    signInMcp({
      agentDir: dir,
      server: "linear",
      store,
      scopes: ["read"],
      fetch: remote.fetch,
      interaction: {
        confirmAuthorization: async () => true,
        notify: (event) => {
          if (event.type === "auth_url") callbacks.push(remote.approve(event.url));
        },
      },
    }),
  ).rejects.toMatchObject({ code: "insufficient_scope" });
  await Promise.all(callbacks);
  expect(await store.list()).toHaveLength(1);
});

it("persists the SDK-selected client authentication method for subsequent refresh", async () => {
  let tokenRequests = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/token")) {
      tokenRequests++;
      expect(new URLSearchParams(String(init?.body)).get("client_secret")).toBe("test-client-secret");
    }
    const response = await remote.fetch(input, init);
    if (url.includes("oauth-authorization-server")) {
      const metadata = (await response.json()) as Record<string, unknown>;
      return Response.json({ ...metadata, token_endpoint_auth_methods_supported: ["client_secret_post"] });
    }
    if (url.endsWith("/register")) {
      const registration = (await response.json()) as Record<string, unknown>;
      delete registration.token_endpoint_auth_method;
      return Response.json({ ...registration, client_secret: "test-client-secret" }, { status: 201 });
    }
    return response;
  };
  const callbacks: Promise<Response>[] = [];
  const grant = await signInMcp({
    agentDir: dir,
    server: "linear",
    store,
    fetch,
    interaction: {
      confirmAuthorization: async () => true,
      notify: (event) => {
        if (event.type === "auth_url") callbacks.push(remote.approve(event.url));
      },
    },
  });
  await Promise.all(callbacks);
  expect((await store.read(grant.id))?.client.tokenEndpointAuthMethod).toBe("client_secret_post");
  await grantToken({ store, id: grant.id, url: remote.url, fetch: mcpFetch(fetch), rejectedGeneration: 0 });
  expect(tokenRequests).toBe(2);
});

it("cancels while waiting for the browser without storing a credential", async () => {
  const abort = new AbortController();
  await expect(
    signInMcp({
      agentDir: dir,
      server: "linear",
      store,
      fetch: remote.fetch,
      interaction: {
        signal: abort.signal,
        confirmAuthorization: async () => true,
        notify: (event) => {
          if (event.type === "auth_url") abort.abort();
        },
      },
    }),
  ).rejects.toMatchObject({ code: "canceled" });
  expect(await store.list()).toEqual([]);
});
