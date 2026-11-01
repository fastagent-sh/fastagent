import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { expect, it, vi, onTestFinished } from "vitest";
import { agentWorkspace, run } from "./cli-run.ts";
import { mcpFixture } from "./mcp-fixture.ts";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

it("MCP login gives a browser ticket, saves a grant/binding and disconnects without deleting the grant", async () => {
  let remote: ReturnType<typeof mcpFixture>;
  const server = createServer(
    getRequestListener(
      async (request) =>
        remote.fetch(request.url, {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }),
        }),
      { overrideGlobalObjects: false },
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  remote = mcpFixture(`http://127.0.0.1:${address.port}`);
  const dir = await agentWorkspace("fa-cli-mcp-", {
    ".mcp.json": JSON.stringify({ mcpServers: { test: { type: "http", url: remote.url } } }),
  });
  const home = await mkdtemp(join(tmpdir(), "fa-cli-mcp-home-"));
  const env = {
    ...process.env,
    HOME: home,
    FASTAGENT_ENVIRONMENT: "dev",
    FASTAGENT_STATE_DIR: "",
    FASTAGENT_SECRETS_DIR: "",
  };
  let ticket: string | undefined;
  onTestFinished(async () => {
    if (ticket) {
      const stored = JSON.parse(
        await readFile(join(home, ".fastagent", ".state", "tickets", `${ticket}.json`), "utf8"),
      );
      if (stored.status === "working" || stored.status === "need_user_action") {
        try {
          process.kill(-stored.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  const listing = await run(["mcp", "list", dir, "--json"], undefined, env);
  expect(JSON.parse(listing.stdout)).toMatchObject([{ name: "test", authorization: "not_bound" }]);
  expect(remote.calls).toEqual([]);
  const noScopes = await run(["mcp", "login", "test", dir, "--json"], undefined, env);
  expect(noScopes.code).toBe(2);
  expect(noScopes.stderr).toContain("--scopes");
  const invalid = await run(
    [
      "mcp",
      "login",
      "test",
      dir,
      "--scopes",
      "read",
      "--client-id",
      "native-client",
      "--callback-port",
      "-1",
      "--json",
    ],
    undefined,
    env,
  );
  let failed = JSON.parse(invalid.stdout);
  ticket = failed.ticket;
  await vi.waitFor(
    async () => {
      if (failed.status === "working")
        failed = JSON.parse(
          (await run(["mcp", "login", "--check", ticket as string, "--json"], undefined, env)).stdout,
        );
      expect(failed.status).toBe("failed");
    },
    { timeout: 15000 },
  );
  expect(failed.agent_next_steps).toContain("--client-id");
  expect(failed.agent_next_steps).toContain("native-client");
  expect(failed.agent_next_steps).toContain("--callback-port");
  expect(failed.agent_next_steps.match(/--json/g)).toHaveLength(1);
  const started = await run(["mcp", "login", "test", dir, "--scopes", "read", "--json"], undefined, env);
  expect(started.code, started.stderr + started.stdout + JSON.stringify(remote.calls)).toBe(0);
  let status = JSON.parse(started.stdout);
  ticket = status.ticket;
  await vi.waitFor(
    async () => {
      if (status.status === "working")
        status = JSON.parse(
          (await run(["mcp", "login", "--check", ticket as string, "--json"], undefined, env)).stdout,
        );
      expect(status.status).toBe("need_user_action");
    },
    { timeout: 15000 },
  );
  expect((await remote.approve(status.url)).status).toBe(200);
  await vi.waitFor(
    async () => {
      status = JSON.parse((await run(["mcp", "login", "--check", ticket as string, "--json"], undefined, env)).stdout);
      expect(status.status).toBe("done");
    },
    { timeout: 15000 },
  );
  const bindings = JSON.parse(await readFile(join(dir, ".state", "mcp-bindings.json"), "utf8"));
  expect(bindings.test).toBe(status.grant_id);
  const grants = await readFile(join(dir, ".secrets", "mcp-auth.json"), "utf8");
  expect(grants).toContain("refreshToken");
  expect(JSON.stringify(status)).not.toContain("accessToken");
  const held = await openLockedStorage(join(dir, ".state", "agent.sqlite"), "posix", "test serving instance");
  try {
    const refused = await run(["mcp", "disconnect", "test", dir, "--json"], undefined, env);
    expect(refused.code).toBe(1);
    expect(JSON.parse(await readFile(join(dir, ".state", "mcp-bindings.json"), "utf8")).test).toBe(status.grant_id);
  } finally {
    await held.close(BACKGROUND_CONTEXT);
  }
  const disconnected = await run(["mcp", "disconnect", "test", dir, "--json"], undefined, env);
  expect(disconnected.code).toBe(0);
  expect(JSON.parse(disconnected.stdout).grant_revoked).toBe(false);
  expect(await readFile(join(dir, ".secrets", "mcp-auth.json"), "utf8")).toBe(grants);
  expect(JSON.parse(await readFile(join(dir, ".state", "mcp-bindings.json"), "utf8"))).toEqual({});
}, 45000);
