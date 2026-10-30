import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runAddChannel } from "../src/cli/commands/add.ts";
import { FEISHU_AGENT_SCOPES } from "../src/channels/feishu/setup-mode.ts";
import { checkTicket, createTicket } from "../src/cli/ticket.ts";
import { agentWorkspace } from "./cli-run.ts";

// At a terminal, so `--json` alone is what says a coding agent runs this (the ticket's own run asks nothing either way).
vi.mock("../src/cli/shared.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/shared.ts")>()),
  isInteractive: () => true,
}));

const exited = new Error("exited");

/** What the command started, recorded: the process it would start is the ticket's own half, run by hand above. */
const started: Record<string, unknown>[] = [];
vi.mock("../src/cli/ticket.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/ticket.ts")>()),
  startTicket: async (input: Record<string, unknown>) => {
    started.push(input);
    return { ticket: "0123456789abcdef", status: "working", expiresAt: Date.now() + 60_000, check: input.check };
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

it("a ticket's run is the whole add: the person waited on, the app written, its next steps the ticket's result", async () => {
  const dir = await agentWorkspace("fa-add-ticket-", {
    "package.json": JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "*" } }),
  });
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  const { ticket } = createTicket({
    subject: "add:feishu:dev",
    action: "confirm the new Feishu app",
    check: "fastagent add feishu --check",
    restart: "fastagent add feishu",
    timeoutSeconds: 60,
  });
  const statuses: string[] = [];
  stubFeishu(statuses, ticket);
  try {
    await expect(runAddChannel("feishu", dir, { ingress: "websocket", ticket })).rejects.toBe(exited);
    expect(statuses).toEqual(["need_user_action", "need_user_action"]);
    const done = await checkTicket(ticket);
    expect(done).toMatchObject({
      status: "done",
      url: expect.stringContaining("user_code=AB-CD"),
      result: {
        written: expect.arrayContaining(["FEISHU_INGRESS"]),
        next_steps: expect.arrayContaining([expect.stringContaining("fastagent dev")]),
      },
      afterwards: [
        {
          instructions: expect.stringContaining("CREATE + PUBLISH a version"),
          url: "https://open.feishu.cn/app/cli_new/version",
        },
      ],
    });
    expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toMatch(/^FEISHU_APP_ID=cli_new$/m);
    expect(await readFile(join(dir, "src", "channels", "feishu.ts"), "utf8")).toContain("feishu");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("a failure inside the run fails the ticket with its reason, not a bare exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-add-ticket-"));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  const { ticket } = createTicket({
    subject: "add:feishu:dev",
    action: "confirm the new Feishu app",
    check: "fastagent add feishu --check",
    restart: "fastagent add feishu",
    timeoutSeconds: 60,
  });
  try {
    await expect(runAddChannel("feishu", dir, { ingress: "websocket", ticket })).rejects.toBe(exited);
    expect(await checkTicket(ticket)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("no package.json"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("--json hands the person's part over even at a terminal: a coding agent may run commands in one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-add-json-"));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  vi.stubEnv("FASTAGENT_STATE_DIR", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  await expect(runAddChannel("lark", dir, { onboard: true, json: true })).rejects.toBe(exited);
  expect(JSON.parse(String(printed.mock.calls[0]?.[0]))).toMatchObject({ status: "need_user_action" });
  await rm(dir, { recursive: true, force: true });
});

it("what the setup was asked reaches its process: --replace-config with the rest, one setup per agent", async () => {
  const dir = await agentWorkspace("fa-add-replace-");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  started.length = 0;
  await expect(runAddChannel("slack", dir, { onboard: true, replaceConfig: true, json: true })).rejects.toBe(exited);
  expect(started).toEqual([
    expect.objectContaining({
      subject: `add:slack:dev:${dir}`,
      restart: expect.stringMatching(/ --replace-config$/),
      command: expect.objectContaining({ args: expect.arrayContaining(["add", "slack", dir, "--replace-config"]) }),
    }),
  ]);
  await rm(dir, { recursive: true, force: true });
});
