import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runChannelsSetup } from "../src/cli/commands/channels.ts";
import { FEISHU_AGENT_SCOPES } from "../src/channels/feishu/setup-mode.ts";
import { checkTicket, createTicket } from "../src/cli/ticket.ts";
import { agentWorkspace } from "./cli-run.ts";

// At a terminal, so `--json` alone is what says a coding agent runs this (the ticket's own run asks nothing either way).
vi.mock("../src/cli/shared.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/shared.ts")>()),
  isInteractive: () => true,
}));

const exited = new Error("exited");
const setup = (name: string, dir: string, opts: Record<string, unknown> = {}) =>
  runChannelsSetup(name, dir, { recordUrl: false, json: false, ...opts });

/** What the command started, recorded: the process it would start is the ticket's own half, run by hand above. */
const started: Record<string, unknown>[] = [];
vi.mock("../src/cli/ticket.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/ticket.ts")>()),
  startTicket: async (input: Record<string, unknown>) => {
    started.push(input);
    return {
      ticket: "0123456789abcdef",
      status: "working",
      expiresAt: Date.now() + 60_000,
      check: input.check,
      fields: input.fields,
    };
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Feishu's accounts and Open API as a new app's setup meets them: confirmed at the second poll, every scope granted. */
function stubFeishu(statuses: string[], ticket: string) {
  let polls = 0;
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes("/oauth/v1/app/registration")) {
      if (new URLSearchParams(String(init.body)).get("action") === "begin") {
        return Response.json({
          device_code: "dev-1",
          verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=AB-CD",
          interval: 0.001,
          expires_in: 600,
        });
      }
      // What the agent's check reads while the person has not confirmed yet.
      statuses.push((await checkTicket(ticket))?.status ?? "gone");
      return polls++ === 0
        ? Response.json({ error: "authorization_pending" }, { status: 400 })
        : Response.json({ client_id: "cli_new", client_secret: "s3cret", user_info: { tenant_brand: "feishu" } });
    }
    if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "T", expire: 7200 });
    if (url.includes("/application/v6/scopes")) {
      const scopes = FEISHU_AGENT_SCOPES.map((entry) => ({ scope_name: entry.request, grant_status: 1 }));
      return Response.json({ code: 0, data: { scopes } });
    }
    throw new Error(`unexpected request ${url}`);
  });
}

it("a ticket's run is the whole setup: the person waited on, the app written, what is left the ticket's result", async () => {
  const dir = await agentWorkspace("fa-add-ticket-", {
    "package.json": JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "*" } }),
  });
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  const { ticket } = createTicket({
    subject: "channels-setup:feishu:dev",
    action: "confirm the new Feishu app",
    check: "fastagent channels setup feishu --check",
    restart: "fastagent channels setup feishu",
    timeoutSeconds: 60,
  });
  const statuses: string[] = [];
  stubFeishu(statuses, ticket);
  try {
    await expect(setup("feishu", dir, { ticket })).rejects.toBe(exited);
    expect(statuses).toEqual(["need_user_action", "need_user_action"]);
    const done = await checkTicket(ticket);
    expect(done).toMatchObject({
      status: "done",
      url: expect.stringContaining("user_code=AB-CD"),
      result: {
        written: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
        next_steps: expect.arrayContaining([
          "fastagent dev",
          expect.stringContaining("CREATE + PUBLISH a version: https://open.feishu.cn/app/cli_new/version"),
        ]),
      },
    });
    expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toMatch(/^FEISHU_APP_ID=cli_new$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("a failure inside the run fails the ticket with its reason, not a bare exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-setup-ticket-"));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  // Feishu's accounts service is down: the app cannot be created.
  vi.stubGlobal("fetch", async () => Response.json({ error: "server_error" }, { status: 500 }));
  const { ticket } = createTicket({
    subject: "channels-setup:feishu:dev",
    action: "confirm the new Feishu app",
    check: "fastagent channels setup feishu --check",
    restart: "fastagent channels setup feishu",
    timeoutSeconds: 60,
  });
  try {
    await expect(setup("feishu", dir, { ticket })).rejects.toBe(exited);
    expect(await checkTicket(ticket)).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/500|server_error/),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("--json hands the person's part over even at a terminal: a coding agent may run commands in one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-setup-json-"));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  vi.stubEnv("FASTAGENT_STATE_DIR", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  started.length = 0;
  await expect(setup("lark", dir, { json: true })).rejects.toBe(exited);
  // Lark's App ID and Secret are not asked for in a file: the setup's own run takes them on a page.
  expect(started).toEqual([expect.objectContaining({ subject: expect.stringMatching(/^channels-setup:lark:/) })]);
  expect(JSON.parse(String(printed.mock.calls[0]?.[0]))).toMatchObject({ status: "working" });
  expect(String(printed.mock.calls[0]?.[0])).not.toContain("value_file");
  await rm(dir, { recursive: true, force: true });
});
