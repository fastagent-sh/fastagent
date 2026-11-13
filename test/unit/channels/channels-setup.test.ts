import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChannelsSetup } from "../../../src/cli/commands/channels.ts";
import { useValueFile } from "../../../src/value-file.ts";
import { agentWorkspace } from "../../doubles/cli-run.ts";

vi.mock("../../../src/git.ts", () => import("../../doubles/git-double.ts"));

// At a terminal, so `--json` alone says a coding agent runs this (the ticket's own run asks nothing either way).
vi.mock("../../../src/cli/shared.ts", async (original) => ({
  ...(await original<typeof import("../../../src/cli/shared.ts")>()),
  isInteractive: () => true,
}));

const prompts = vi.hoisted(() => ({
  answers: [] as (string | symbol)[],
  asked: [] as string[],
  errors: [] as string[],
  infos: [] as string[],
}));
vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown) => typeof value === "symbol",
  password: async ({ message }: { message: string }) => {
    prompts.asked.push(message);
    // Out of answers, a person who walks away: a test that asks more than it said fails, and never loops.
    return prompts.answers.shift() ?? Symbol("cancel");
  },
  log: { info: (m: string) => prompts.infos.push(m), error: (m: string) => prompts.errors.push(m) },
}));

const opened: string[] = [];
vi.mock("../../../src/open-url.ts", () => ({ openExternalUrl: (url: string) => opened.push(url) }));

/** What `process.exit` does here: it ends the command, with a code a test can read, instead of the process. */
class Exit extends Error {
  readonly code: number | undefined;
  constructor(code: number | undefined) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** The command ends the process with `code` (0: it carried out the setup; 1: it failed; 2: it was misused). */
async function ends(run: Promise<void>, code = 0): Promise<void> {
  const outcome = await run.then(
    () => undefined,
    (error: unknown) => error,
  );
  const said = () => vi.mocked(console.error).mock.calls.flat().join("\n");
  expect(outcome, `the command returned instead of ending the process\n${said()}`).toBeInstanceOf(Exit);
  expect((outcome as Exit).code, said()).toBe(code);
}
const GOOD_BOT = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";
const GOOD_SLACK_BOT = "xoxb-good";
const GOOD_APP = "xapp-1-A1-1-good";

/** Telegram's and Slack's Web APIs as a token is checked against them. Everything else goes to the real fetch. */
function platforms(options: { unreachable?: boolean; groupPrivacy?: "off" | "on" | "unreported" } = {}) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const telegram = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/);
    if (telegram) {
      calls.push(`telegram ${telegram[2]}`);
      if (options.unreachable) throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
      return telegram[1] === GOOD_BOT
        ? Response.json({
            ok: true,
            result: {
              username: "acme_bot",
              ...(options.groupPrivacy === "unreported"
                ? {}
                : { can_read_all_group_messages: options.groupPrivacy !== "on" }),
            },
          })
        : Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
    }
    const slack = url.match(/^https:\/\/slack\.com\/api\/([\w.]+)/);
    if (slack) {
      const token = new Headers(init?.headers).get("authorization");
      calls.push(`slack ${slack[1]} ${token}`);
      if (slack[1] === "auth.test") {
        return Response.json(
          token === `Bearer ${GOOD_SLACK_BOT}`
            ? { ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" }
            : { ok: false, error: "invalid_auth" },
        );
      }
      return Response.json(
        token === `Bearer ${GOOD_APP}`
          ? { ok: true, url: "wss://wss.test/link" }
          : { ok: false, error: "invalid_auth" },
      );
    }
    return real(input, init);
  });
  return calls;
}

beforeEach(() => {
  prompts.answers.length = 0;
  prompts.asked.length = 0;
  prompts.errors.length = 0;
  prompts.infos.length = 0;
  opened.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Exit(code as number | undefined);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useValueFile(undefined);
  delete process.env.FASTAGENT_DEV;
  delete process.env.FASTAGENT_ENVIRONMENT;
});

const workspace = (prefix: string, files: Record<string, string> = {}) => agentWorkspace(prefix, files);
const read = (file: string) => readFile(file, "utf8");
/** `--env-file` names a file that exists, as it does everywhere: a test that is not about that makes it first. */
const setup = async (name: string, dir: string, opts: Record<string, unknown> = {}) => {
  if (typeof opts.envFile === "string" && !existsSync(opts.envFile)) await writeFile(opts.envFile, "");
  return runChannelsSetup(name, dir, { recordUrl: false, json: false, ...opts });
};

describe("channels setup at a terminal", () => {
  it("asks for what the development instance's way needs, checks it, and keeps it: a polling bot needs only its token", async () => {
    const dir = await workspace("fa-setup-telegram-");
    const calls = platforms();
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir));
    const env = await read(join(dir, ".secrets", ".env"));
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${GOOD_BOT}`);
    expect(env).not.toContain("TELEGRAM_SECRET_TOKEN");
    expect(prompts.asked).toEqual(["Bot token"]);
    expect(prompts.infos[0]).toContain("@BotFather");
    expect(opened).toEqual(["https://t.me/BotFather"]);
    expect(calls).toEqual(["telegram getMe"]);
  });

  it("refuses the wrong kind of Slack token, and says which one it asked for", async () => {
    const dir = await workspace("fa-setup-slack-wrong-");
    platforms();
    prompts.answers.push(
      "xoxe.xoxp-1-rotating",
      GOOD_APP,
      "xoxb-revoked",
      GOOD_SLACK_BOT,
      GOOD_SLACK_BOT,
      "xapp-1-A1-1-revoked",
      GOOD_APP,
    );
    await ends(setup("slack", dir));
    expect(prompts.errors.map((line) => line.split(".")[0])).toEqual([
      "That is a rotating token, which FastAgent does not support",
      "That is not a bot token",
      "Slack does not accept this token",
      "That is not an app-level token",
      "Slack does not accept this token",
    ]);
  });
});

describe("channels setup for a coding agent (stateless --json)", () => {
  const printedJson = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);

  it("returns structured missing steps and exits 2 when credentials are missing or refused, without prompting", async () => {
    const dir = await workspace("fa-setup-stateless-");
    platforms();
    await ends(setup("telegram", dir, { json: true }), 2);
    expect(prompts.asked).toEqual([]);
    expect(existsSync(join(dir, ".secrets", ".env"))).toBe(false);
    expect(printedJson()).toMatchObject({
      status: "need_user_action",
      channel: "telegram",
      file: join(dir, ".secrets", ".env"),
      steps: [
        expect.objectContaining({
          label: "Bot token",
          url: "https://t.me/BotFather",
          fields: [{ name: "TELEGRAM_BOT_TOKEN", label: "Bot token", secret: true }],
        }),
      ],
    });

    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), "TELEGRAM_BOT_TOKEN=not-a-token\n");
    await ends(setup("telegram", dir, { json: true }), 2);
    expect(printedJson().steps[0].error).toContain("That is not a bot token.");
  });

  it("validates existing credentials in the value file and exits 0 when ready", async () => {
    const dir = await workspace("fa-setup-ready-");
    platforms();
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), `TELEGRAM_BOT_TOKEN=${GOOD_BOT}\n`);
    await ends(setup("telegram", dir, { json: true }), 0);
    expect(printedJson()).toMatchObject({
      status: "done",
      channel: "telegram",
      kept: ["TELEGRAM_BOT_TOKEN"],
      next_steps: expect.arrayContaining(["fastagent dev"]),
    });
  });
});
