/**
 * `mcp login` without a terminal, for a coding agent: a ticket the person finishes in a browser. The command that starts
 * it, the step that runs it and the command that reads it are each tested where they are decided, in this process, as
 * cli-login-ticket.test.ts does for a model sign-in. That a step outlives the command that starts it is `startTicket`'s,
 * tested with real processes in ticket.integration.test.ts.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTicket } from "../src/cli/ticket.ts";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { agentWorkspace, runInProcess } from "./cli-run.ts";
import { mcpFixture } from "./mcp-fixture.ts";

vi.mock("../src/git.ts", () => import("./git-double.ts"));
// A disconnect refused while a serve holds the storage is refused at once (the wait is storage.integration.test.ts's).
vi.mock("../src/harnesses/pi-durable/storage.ts", () => import("./storage-no-wait.ts"));

/** What the command asked `startTicket` to start: the step's own process is run by hand below. */
const started: unknown[] = [];
vi.mock("../src/cli/ticket.ts", async (original) => {
  const real = await original<typeof import("../src/cli/ticket.ts")>();
  return {
    ...real,
    startTicket: async (input: Parameters<typeof real.startTicket>[0]) => {
      started.push(input);
      return { ...real.createTicket(input), status: "working" as const };
    },
  };
});

const REQUEST = {
  subject: "mcp:login:dev:test",
  action: "authorize MCP server test",
  check: "fastagent mcp login --check",
  restart: "fastagent mcp login test",
  timeoutSeconds: 60,
};
const env = { ...process.env, FASTAGENT_ENVIRONMENT: "dev", FASTAGENT_STATE_DIR: "", FASTAGENT_SECRETS_DIR: "" };

/** The MCP server and its authorization server, on loopback, where the command's own fetch reaches them. */
let remote: ReturnType<typeof mcpFixture>;
let close: () => Promise<void>;
beforeEach(async () => {
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
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
});
afterEach(async () => {
  started.splice(0);
  await close();
});

const agent = () =>
  agentWorkspace("fa-cli-mcp-", {
    "context.json": JSON.stringify({ mcpServers: { test: { type: "http", url: remote.url } } }),
  });
const ticketOf = async (id: string) =>
  JSON.parse(
    await readFile(join(process.env.HOME as string, ".fastagent", ".state", "tickets", `${id}.json`), "utf8"),
  ) as {
    status: string;
    url?: string;
  };
const checked = async (id: string) =>
  JSON.parse((await runInProcess(["mcp", "login", "--check", id, "--json"], undefined, env)).stdout) as Record<
    string,
    unknown
  >;

describe("mcp login, without a terminal", () => {
  it("needs the scopes, and asks for a ticket that runs the same login, reporting how to check it", async () => {
    const dir = await agent();
    const noScopes = await runInProcess(["mcp", "login", "test", dir, "--json"], undefined, env);
    expect(noScopes.code).toBe(2);
    expect(noScopes.stderr).toContain("--scopes");
    const args = [
      "mcp",
      "login",
      "test",
      dir,
      "--scopes",
      "read",
      "--client-id",
      "native-client",
      "--callback-port",
      "8765",
    ];
    const result = await runInProcess([...args, "--json"], undefined, env);
    expect(result.code, result.stderr).toBe(0);
    const [asked] = started as [Record<string, unknown> & { command: { args: string[] } }];
    expect(asked).toMatchObject({
      subject: `mcp:login:dev:${dir}:test`,
      action: "authorize MCP server test",
      waitsFirst: false,
      whenRunning: "replace",
    });
    expect(asked.command.args.slice(-14)).toEqual([
      ...["mcp", "login", "test", dir, "--env", "dev", "--scopes", "read", "--timeout", "900"],
      ...["--client-id", "native-client", "--callback-port", "8765"],
    ]);
    // What a failed ticket hands the agent to run again: the same login, its flags kept, its `--json` added once.
    expect(asked.restart).toBe(
      `fastagent mcp login test ${dir} --env dev --scopes read --timeout 900 --client-id native-client --callback-port 8765`,
    );
    const report = JSON.parse(result.stdout) as { ticket: string; status: string };
    expect(report.status).toBe("working");
    expect(remote.calls).toEqual([]); // nothing is asked of the server before the step runs
  });

  it("a step whose callback port cannot be served fails its ticket with the reason", async () => {
    const dir = await agent();
    const { ticket } = createTicket(REQUEST);
    const step = await runInProcess(
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
        "--ticket",
        ticket,
      ],
      undefined,
      env,
    );
    expect(step.code).toBe(0); // the step's process ends 0 whatever its step did: its ticket says how it ended
    expect(await checked(ticket)).toMatchObject({
      status: "failed",
      message: "test: Invalid MCP sign-in timeout or callback port",
    });
  });

  it("a step waits on its person at the authorization address, then saves the grant and binds it; disconnect keeps the grant", async () => {
    const dir = await agent();
    const { ticket } = createTicket(REQUEST);
    // The step holds this process until its person has answered: nothing else runs through runInProcess meanwhile, and
    // the person's side is the ticket's files (`checkTicket`) and the browser (`approve`).
    const ended = runInProcess(["mcp", "login", "test", dir, "--scopes", "read", "--ticket", ticket], undefined, env);
    // Read from its file: a check before the step has claimed its ticket would take it for a step that never ran.
    await vi.waitFor(async () => expect((await ticketOf(ticket)).status).toBe("need_user_action"));
    expect((await remote.approve((await ticketOf(ticket)).url as string)).status).toBe(200);
    expect((await ended).code).toBe(0);

    const done = await checked(ticket);
    expect(done).toMatchObject({ status: "done", grant_id: expect.any(String) });
    expect(JSON.stringify(done)).not.toContain("accessToken");
    const bindings = join(dir, ".fastagent", "dev", ".state", "mcp-bindings.json");
    expect(JSON.parse(await readFile(bindings, "utf8")).test).toBe(done.grant_id);
    const grants = await readFile(join(dir, ".secrets", "mcp-auth.json"), "utf8");
    expect(grants).toContain("refreshToken");

    const held = await openLockedStorage(join(dir, ".fastagent", "dev", ".state", "agent.sqlite"), "posix", "a serve");
    try {
      const refused = await runInProcess(["mcp", "disconnect", "test", dir, "--json"], undefined, env);
      expect(refused.code).toBe(1);
      expect(JSON.parse(await readFile(bindings, "utf8")).test).toBe(done.grant_id);
    } finally {
      await held.close(BACKGROUND_CONTEXT);
    }
    const disconnected = await runInProcess(["mcp", "disconnect", "test", dir, "--json"], undefined, env);
    expect(disconnected.code).toBe(0);
    expect(JSON.parse(disconnected.stdout).grant_revoked).toBe(false);
    expect(await readFile(join(dir, ".secrets", "mcp-auth.json"), "utf8")).toBe(grants);
    expect(JSON.parse(await readFile(bindings, "utf8"))).toEqual({});
  });
});
