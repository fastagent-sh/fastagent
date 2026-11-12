import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUpChannel } from "../src/cli/channel-setup.ts";
import { runChannelsSetup } from "../src/cli/commands/channels.ts";
import { checkTicket, createTicket } from "../src/cli/ticket.ts";
import { scaffoldChannel } from "../src/scaffold/add-channel.ts";
import { useValueFile } from "../src/value-file.ts";
import { agentWorkspace } from "./cli-run.ts";
import { gitAnswersIn } from "./git-double.ts";

vi.mock("../src/git.ts", () => import("./git-double.ts"));

// At a terminal, so `--json` alone says a coding agent runs this (the ticket's own run asks nothing either way).
vi.mock("../src/cli/shared.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/shared.ts")>()),
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
vi.mock("../src/open-url.ts", () => ({ openExternalUrl: (url: string) => opened.push(url) }));

/** What the command started, recorded: the process it would start is the ticket's own half, run by hand below. */
const started: Record<string, unknown>[] = [];
vi.mock("../src/cli/ticket.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/ticket.ts")>()),
  startTicket: async (input: Record<string, unknown>) => {
    started.push(input);
    return { ticket: "0123456789abcdef", status: "working", expiresAt: Date.now() + 60_000, check: input.check };
  },
}));

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
const SIGNING = "0123456789abcdef0123456789abcdef";

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
  started.length = 0;
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

/** The links a manifest link opens, as Slack reads them. */
const manifestOf = (link: string | undefined) =>
  JSON.parse(new URL(link as string).searchParams.get("manifest_json") as string);

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

  describe("what it says about group privacy mode", () => {
    const nextSteps = () => vi.mocked(console.error).mock.calls.flat().join("\n");

    it("tells a person whose bot has it on how to turn it off, and to add the bot to its groups again", async () => {
      const dir = await workspace("fa-setup-gp-on-");
      platforms({ groupPrivacy: "on" });
      prompts.answers.push(GOOD_BOT);
      await ends(setup("telegram", dir));
      expect(nextSteps()).toContain("group privacy mode is on");
      expect(nextSteps()).toContain("/setprivacy");
      expect(nextSteps()).toContain("add it again");
    });

    it("says nothing about it when the bot already reads every message of a group", async () => {
      const dir = await workspace("fa-setup-gp-off-");
      platforms({ groupPrivacy: "off" });
      prompts.answers.push(GOOD_BOT);
      await ends(setup("telegram", dir));
      expect(nextSteps()).not.toContain("group privacy");
    });

    it("says it could not tell when Telegram did not report it, rather than taking it for off", async () => {
      const dir = await workspace("fa-setup-gp-unreported-");
      platforms({ groupPrivacy: "unreported" });
      prompts.answers.push(GOOD_BOT);
      await ends(setup("telegram", dir));
      expect(nextSteps()).toContain("did not say whether group privacy mode is on");
      expect(nextSteps()).toContain("/setprivacy");
      expect(nextSteps()).not.toContain("Bot Settings");
    });
  });

  it("is safe to run again: a value the platform still accepts is kept unasked, one it refuses is asked for again", async () => {
    const dir = await workspace("fa-setup-again-");
    platforms();
    await writeFile(join(dir, ".secrets", ".env"), `TELEGRAM_BOT_TOKEN=${GOOD_BOT}\n`);
    await ends(setup("telegram", dir));
    expect(prompts.asked).toEqual([]);

    await writeFile(
      join(dir, ".secrets", ".env"),
      "TELEGRAM_BOT_TOKEN=999999999:revokedrevokedrevokedrevokedrevoked\n",
    );
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir));
    expect(prompts.asked).toEqual(["Bot token"]);
    const env = await read(join(dir, ".secrets", ".env"));
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${GOOD_BOT}`);
    expect(env).not.toContain("revoked");
    expect(env.match(/^TELEGRAM_BOT_TOKEN=/gm)).toHaveLength(1);
  });

  it("a held value whose check could not be made ends the setup: it is neither kept as good nor asked for again", async () => {
    const dir = await workspace("fa-setup-held-network-");
    platforms({ unreachable: true });
    await writeFile(join(dir, ".secrets", ".env"), `TELEGRAM_BOT_TOKEN=${GOOD_BOT}\n`);
    await ends(setup("telegram", dir), 1);
    expect(prompts.asked).toEqual([]);
    expect(await read(join(dir, ".secrets", ".env"))).toBe(`TELEGRAM_BOT_TOKEN=${GOOD_BOT}\n`);
  });

  it("says why a value is refused, and asks again; an empty answer is asked again too", async () => {
    const dir = await workspace("fa-setup-refused-");
    platforms();
    prompts.answers.push("", "not a token", "999999999:wrongwrongwrongwrongwrongwrongwrong", GOOD_BOT);
    await ends(setup("telegram", dir));
    expect(prompts.errors).toEqual([
      "Bot token is needed.",
      expect.stringContaining("That is not a bot token."),
      expect.stringContaining("Telegram does not accept this token."),
    ]);
    expect(await read(join(dir, ".secrets", ".env"))).toContain(`TELEGRAM_BOT_TOKEN=${GOOD_BOT}`);
  });

  it("a check that could not be made ends the setup, instead of asking again for a value that may be right", async () => {
    const dir = await workspace("fa-setup-network-");
    vi.stubGlobal("fetch", async () => {
      throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
    });
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir), 1); // failStartup: the process ends with the reason
    expect(prompts.asked).toEqual(["Bot token"]);
  });

  it("another instance than the development one receives by webhook: the secret that verifies it is made once", async () => {
    const dir = await workspace("fa-setup-webhook-");
    platforms();
    const file = join(dir, "prod.env");
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir, { envFile: file }));
    const secret = (await read(file)).match(/^TELEGRAM_SECRET_TOKEN=([0-9a-f]{48})$/m)?.[1];
    expect(secret).toBeDefined();
    // The development instance's file is not touched.
    await expect(read(join(dir, ".secrets", ".env"))).rejects.toThrow();

    await ends(setup("telegram", dir, { envFile: file }));
    expect((await read(file)).match(/^TELEGRAM_SECRET_TOKEN=(.*)$/m)?.[1]).toBe(secret);
  });

  it("naming a configuration is another instance, a deployment's, which has no default file: it asks for --env-file, and keeps its values there", async () => {
    const dir = await workspace("fa-setup-config-only-");
    platforms();
    const config = join(dir, "prod.json");
    await writeFile(config, "{}");
    await ends(setup("telegram", dir, { config }), 2);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("pass --env-file <file>");
    // Nothing was made: not the file `start` reads, and not the development one.
    await expect(read(join(dir, ".secrets", "production", ".env"))).rejects.toThrow();
    await expect(read(join(dir, ".secrets", ".env"))).rejects.toThrow();

    const file = join(dir, "prod.env");
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir, { config, envFile: file }));
    const production = await read(file);
    expect(production).toContain(`TELEGRAM_BOT_TOKEN=${GOOD_BOT}`);
    // Not dev's: a webhook's secret came with it, and the development file was not made.
    expect(production).toMatch(/^TELEGRAM_SECRET_TOKEN=/m);
    await expect(read(join(dir, ".secrets", ".env"))).rejects.toThrow();
  });

  it("says once that a directory it does not own now holds secrets, however many values went there", async () => {
    const dir = await workspace("fa-setup-unprotected-");
    platforms();
    const elsewhere = await mkdtemp(join(tmpdir(), "fa-setup-elsewhere-"));
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir, { envFile: join(elsewhere, "prod.env") }));
    const said = vi.mocked(console.error).mock.calls.flat().map(String);
    // Two values were written (the token and a webhook's secret), and the note is said once, naming the directory.
    expect(said.filter((line) => line.includes("now holds a secret and has no .gitignore"))).toEqual([
      expect.stringContaining(`note: ${elsewhere} (where this instance keeps its values) now holds a secret`),
    ]);
  });

  it("says a value file git would track, once, and nothing once git ignores it", async () => {
    const dir = await workspace("fa-setup-tracked-");
    // What `init` scaffolds: a `.gitignore` of the author's own, whose rules name `.env` and not this file.
    await writeFile(join(dir, ".gitignore"), ".env\n.env.*\n");
    gitAnswersIn(dir, { "rev-parse --is-inside-work-tree": "true", "check-ignore -q prod.env": undefined });
    platforms();
    const file = join(dir, "prod.env");
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir, { envFile: file }));
    const said = vi.mocked(console.error).mock.calls.flat().map(String);
    expect(said.filter((line) => line.includes("holds secrets and is not ignored by git"))).toHaveLength(1);

    vi.mocked(console.error).mockClear();
    gitAnswersIn(dir, { "rev-parse --is-inside-work-tree": "true", "check-ignore -q prod.env": "" });
    await rm(file);
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir, { envFile: file }));
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toContain("not ignored by git");
  });

  it("--env-file names the file its values are kept in, created when missing, and refused when it is not a file", async () => {
    const dir = await workspace("fa-setup-envfile-");
    platforms();
    const made = join(dir, "made.env");
    prompts.answers.push(GOOD_BOT);
    await ends(runChannelsSetup("telegram", dir, { recordUrl: false, json: false, envFile: made }));
    expect(await read(made)).toContain(`TELEGRAM_BOT_TOKEN=${GOOD_BOT}`);

    // A directory is not a file the values can be kept in.
    await ends(runChannelsSetup("telegram", dir, { recordUrl: false, json: false, envFile: dir }), 2);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(`--env-file ${dir} is not a file`);
  });

  it("--ingress is written to the configuration: the development instance's, or the one --config names", async () => {
    const dir = await workspace("fa-setup-ingress-");
    platforms();
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir, { ingress: "webhook" }));
    expect(JSON.parse(await read(join(dir, "fastagent.json")))).toEqual({
      channels: { telegram: { ingress: "webhook" } },
    });
    // Webhook, so the secret came with it.
    expect(await read(join(dir, ".secrets", ".env"))).toMatch(/^TELEGRAM_SECRET_TOKEN=/m);

    const config = join(dir, "prod.json");
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir, { ingress: "connection", config, envFile: join(dir, "prod.env") }));
    expect(JSON.parse(await read(config))).toEqual({ channels: { telegram: { ingress: "connection" } } });
  });

  it("takes the way the configuration names, and refuses an --ingress with nowhere to write it", async () => {
    const dir = await workspace("fa-setup-named-");
    await scaffoldChannel(dir, "telegram");
    platforms();
    const config = join(dir, "prod.json");
    await writeFile(config, JSON.stringify({ channels: { telegram: { ingress: "connection" } } }));
    prompts.answers.push(GOOD_BOT);
    await ends(setup("telegram", dir, { config, envFile: join(dir, "prod.env") }));
    expect(await read(join(dir, "prod.env"))).not.toContain("TELEGRAM_SECRET_TOKEN");

    await ends(setup("telegram", dir, { ingress: "webhook", envFile: join(dir, "x.env") }), 2);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("--ingress writes into a configuration");
    await ends(setup("telegram", dir, { ingress: "sometimes" }), 2);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      '--ingress must be "webhook" or "connection"',
    );
  });

  it("refuses a way the channel file cannot receive, naming it", async () => {
    const dir = await workspace("fa-setup-oneway-", {
      "src/channels/telegram.ts": `import { needs } from "@fastagent-sh/fastagent";
import { telegramChannel } from "@fastagent-sh/fastagent/telegram";
export default needs(["TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET_TOKEN"], (secrets) =>
  telegramChannel({ botToken: secrets.TELEGRAM_BOT_TOKEN, secretToken: secrets.TELEGRAM_SECRET_TOKEN }),
);\n`,
    });
    platforms();
    await ends(setup("telegram", dir), 1);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "the agent does not build for telegram to receive by connection",
    );
    await expect(read(join(dir, ".secrets", ".env"))).rejects.toThrow();
  });

  it("Slack in Socket Mode: the app is made from a link that sets Socket Mode, then its bot token and app-level token", async () => {
    const dir = await workspace("fa-setup-slack-connection-");
    const calls = platforms();
    prompts.answers.push(GOOD_SLACK_BOT, GOOD_APP);
    await ends(setup("slack", dir));
    const env = await read(join(dir, ".secrets", ".env"));
    expect(env).toContain(`SLACK_BOT_TOKEN=${GOOD_SLACK_BOT}`);
    expect(env).toContain(`SLACK_APP_TOKEN=${GOOD_APP}`);
    expect(env).not.toContain("SLACK_SIGNING_SECRET");
    expect(prompts.asked).toEqual(["Bot User OAuth Token", "App-Level Token"]);
    // The first link is the app's manifest: Socket Mode on, no Request URL to answer.
    expect(opened).toHaveLength(1);
    const manifest = manifestOf(opened[0]);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.request_url).toBeUndefined();
    expect(manifest.settings.event_subscriptions.bot_events).toContain("message.im");
    expect(manifest.display_information.name).toMatch(/^FastAgent fa-setup-slack-connection/);
    expect(calls).toEqual([
      `slack auth.test Bearer ${GOOD_SLACK_BOT}`,
      `slack apps.connections.open Bearer ${GOOD_APP}`,
    ]);
  });

  it("Slack by webhook: the manifest names the configuration's URL (else a placeholder), and the signing secret is asked", async () => {
    const dir = await workspace("fa-setup-slack-webhook-");
    platforms();
    const config = join(dir, "prod.json");
    await writeFile(config, JSON.stringify({ http: { publicUrl: "https://agent.acme.com" } }));
    prompts.answers.push(GOOD_SLACK_BOT, SIGNING);
    await ends(setup("slack", dir, { config, envFile: join(dir, "prod.env") }));
    const env = await read(join(dir, "prod.env"));
    expect(env).toContain(`SLACK_SIGNING_SECRET=${SIGNING}`);
    expect(env).not.toContain("SLACK_APP_TOKEN");
    const manifest = manifestOf(opened[0]);
    expect(manifest.settings.socket_mode_enabled).toBe(false);
    expect(manifest.settings.event_subscriptions.request_url).toBe("https://agent.acme.com/slack");
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

describe("setUpChannel: writes where it is told, and makes its own values once", () => {
  it("keeps the values in the file it is given, not the one the process selected, and reports what it did", async () => {
    const dir = await workspace("fa-setup-direct-");
    platforms();
    const elsewhere = join(dir, "elsewhere.env");
    prompts.answers.push(GOOD_BOT);
    const first = await setUpChannel({
      kind: "telegram",
      agentDir: dir,
      file: elsewhere,
      way: "webhook",
      dev: false,
      rerun: "again",
    });
    expect(first.written.sort()).toEqual(["TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET_TOKEN"]);
    expect(first.kept).toEqual([]);
    expect(await read(elsewhere)).toContain(`TELEGRAM_BOT_TOKEN=${GOOD_BOT}`);
    await expect(read(join(dir, ".secrets", ".env"))).rejects.toThrow();

    const secret = (await read(elsewhere)).match(/^TELEGRAM_SECRET_TOKEN=(.*)$/m)?.[1];
    const again = await setUpChannel({
      kind: "telegram",
      agentDir: dir,
      file: elsewhere,
      way: "webhook",
      dev: false,
      rerun: "again",
    });
    // Nothing asked, nothing written: both are held, and the one setup made stays what it was.
    expect(again).toMatchObject({ written: [], kept: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET_TOKEN"] });
    expect((await read(elsewhere)).match(/^TELEGRAM_SECRET_TOKEN=(.*)$/m)?.[1]).toBe(secret);
    expect(prompts.asked).toEqual(["Bot token"]);
  });
});

describe("channels setup: what Slack's signing secret can and cannot be checked for", () => {
  it("takes it by its shape alone, and refuses what is plainly another credential", async () => {
    const dir = await workspace("fa-setup-signing-");
    platforms();
    const file = join(dir, "prod.env");
    prompts.answers.push(GOOD_SLACK_BOT, "xoxb-not-a-secret", SIGNING);
    await ends(setup("slack", dir, { envFile: file }));
    expect(prompts.errors).toEqual([expect.stringContaining("That is not a signing secret.")]);
    expect(await read(file)).toContain(`SLACK_SIGNING_SECRET=${SIGNING}`);
  });
});

describe("channels setup for a coding agent", () => {
  it("hands the setup to a ticket's process, forwarding what places the instance", async () => {
    const dir = await workspace("fa-setup-json-");
    await ends(
      setup("slack", dir, { json: true, ingress: "webhook", config: "prod.json", envFile: join(dir, "prod.env") }),
    );
    expect(started).toEqual([
      expect.objectContaining({
        subject: expect.stringMatching(/^channels-setup:slack:.*prod\.env$/),
        check: "fastagent channels setup slack --check",
        whenRunning: "replace",
        command: expect.objectContaining({
          args: expect.arrayContaining(["channels", "setup", "slack", dir, "--ingress", "webhook"]),
        }),
      }),
    ]);
    const args = (started[0] as { command: { args: string[] } }).command.args;
    expect(args).toContain(join(process.cwd(), "prod.json"));
    expect(args).toContain(join(dir, "prod.env"));
  });

  /** The ticket's own process: the page its person is sent to, and what they paste there. */
  async function onPage(name: string, dir: string, opts: Record<string, unknown> = {}) {
    const { ticket } = createTicket({
      subject: `channels-setup:${name}`,
      action: "set up the app",
      check: `fastagent channels setup ${name} --check`,
      restart: "again",
      timeoutSeconds: 60,
    });
    const run = setup(name, dir, { ticket, ...opts });
    run.catch(() => {});
    const waiting = async () => {
      for (let tries = 0; tries < 200; tries++) {
        const current = await checkTicket(ticket);
        if (current?.status === "need_user_action" && current.url) return current;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`the ticket never asked its person for anything: ${JSON.stringify(await checkTicket(ticket))}`);
    };
    const paste = async (fields: Record<string, string>) => {
      const { url } = await waiting();
      const response = await fetch(url as string, { method: "POST", body: new URLSearchParams(fields) });
      return { status: response.status, html: await response.text() };
    };
    return { ticket, run, waiting, paste };
  }

  it("asks on a page, takes the values there, and reports what it wrote as the ticket's result", async () => {
    const dir = await workspace("fa-setup-page-");
    platforms();
    const { ticket, run, waiting, paste } = await onPage("telegram", dir);
    const asked = await waiting();
    expect(asked.instructions).toContain("paste Bot token on this page");
    expect(asked.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup\//);
    const page = await (await fetch(asked.url as string)).text();
    expect(page).toContain("Bot token");
    expect(page).toContain("@BotFather");

    const refused = await paste({ TELEGRAM_BOT_TOKEN: "not a token" });
    expect(refused.html).toContain("That is not a bot token.");
    await expect(read(join(dir, ".secrets", ".env"))).rejects.toThrow();

    expect((await paste({ TELEGRAM_BOT_TOKEN: GOOD_BOT })).html).toContain("Telegram connected");
    await ends(run);
    expect(await read(join(dir, ".secrets", ".env"))).toContain(`TELEGRAM_BOT_TOKEN=${GOOD_BOT}`);
    expect(await checkTicket(ticket)).toMatchObject({
      status: "done",
      result: { written: ["TELEGRAM_BOT_TOKEN"], kept: [], next_steps: expect.arrayContaining(["fastagent dev"]) },
    });
  });

  it("hands a coding agent the group privacy step in the ticket's next_steps, for it to tell the person", async () => {
    const dir = await workspace("fa-setup-page-gp-");
    platforms({ groupPrivacy: "on" });
    const { ticket, run, waiting, paste } = await onPage("telegram", dir);
    await waiting();
    await paste({ TELEGRAM_BOT_TOKEN: GOOD_BOT });
    await ends(run);
    const done = await checkTicket(ticket);
    expect(done).toMatchObject({ status: "done" });
    const steps = (done?.result?.next_steps ?? []) as string[];
    expect(steps.join("\n")).toContain("/setprivacy");
    expect(steps.join("\n")).toContain("add it again");
  });

  it("keeps a value that passed when another is refused, and then asks only for what is left", async () => {
    const dir = await workspace("fa-setup-partial-");
    platforms();
    const { run, paste } = await onPage("slack", dir);
    const first = await paste({ SLACK_BOT_TOKEN: GOOD_SLACK_BOT, SLACK_APP_TOKEN: "xapp-1-A1-1-revoked" });
    expect(first.html).toContain("Slack does not accept this token.");
    // The bot token that passed is kept already, and the form no longer asks for it.
    expect(await read(join(dir, ".secrets", ".env"))).toContain(`SLACK_BOT_TOKEN=${GOOD_SLACK_BOT}`);
    expect(first.html).toContain("Saved.");
    expect(first.html).not.toContain('name="SLACK_BOT_TOKEN"');
    expect((await paste({ SLACK_APP_TOKEN: GOOD_APP })).html).toContain("Slack connected");
    await ends(run);
    expect(await read(join(dir, ".secrets", ".env"))).toContain(`SLACK_APP_TOKEN=${GOOD_APP}`);
  });

  it("a check that could not be made fails the ticket with its reason, not the page's form", async () => {
    const dir = await workspace("fa-setup-page-network-");
    platforms({ unreachable: true });
    const { ticket, run, paste } = await onPage("telegram", dir);
    const stopped = await paste({ TELEGRAM_BOT_TOKEN: GOOD_BOT });
    expect(stopped.html).toContain("Setup stopped");
    expect(stopped.html).toContain("ENOTFOUND api.telegram.org");
    await ends(run);
    expect(await checkTicket(ticket)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("ENOTFOUND api.telegram.org"),
    });
    await expect(read(join(dir, ".secrets", ".env"))).rejects.toThrow();
  });
});
