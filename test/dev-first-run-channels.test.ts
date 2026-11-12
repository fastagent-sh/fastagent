import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUpMissingChannels } from "../src/cli/first-run-channels.ts";
import { scaffoldChannel } from "../src/scaffold/add-channel.ts";
import { agentWorkspace } from "./cli-run.ts";

vi.mock("../src/git.ts", () => import("./git-double.ts"));

let interactive = true;
vi.mock("../src/cli/shared.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/shared.ts")>()),
  isInteractive: () => interactive,
}));

const prompts = vi.hoisted(() => ({ answers: [] as (string | symbol)[], asked: [] as string[] }));
vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown) => typeof value === "symbol",
  password: async ({ message }: { message: string }) => {
    prompts.asked.push(message);
    return prompts.answers.shift() ?? Symbol("cancel");
  },
  log: { info: () => {}, error: () => {} },
}));
vi.mock("../src/open-url.ts", () => ({ openExternalUrl: () => {} }));

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

const GOOD_BOT = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";
let said: string[];

beforeEach(() => {
  interactive = true;
  prompts.answers.length = 0;
  prompts.asked.length = 0;
  said = [];
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
  vi.stubEnv("TELEGRAM_SECRET_TOKEN", undefined);
  vi.spyOn(console, "error").mockImplementation((line) => void said.push(String(line)));
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Exit(code as number | undefined);
  });
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const telegram = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/);
    if (!telegram) return real(input, init);
    return telegram[1] === GOOD_BOT
      ? Response.json({ ok: true, result: { username: "acme_bot" } })
      : Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** An agent with the Telegram channel `add telegram` writes, and no credentials. */
async function telegramAgent(files: Record<string, string> = {}): Promise<string> {
  const dir = await agentWorkspace("fa-dev-first-run-", {
    "package.json": JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "*" } }),
    ...files,
  });
  await scaffoldChannel(dir, "telegram");
  return dir;
}

const outcome = (run: Promise<void>) =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("dev sets up the channels the development instance lacks", () => {
  it("asks once for what the channel's setup supplies, keeps it, and makes it this process's", async () => {
    const dir = await telegramAgent();
    prompts.answers.push(GOOD_BOT);
    await setUpMissingChannels(dir);
    expect(prompts.asked).toEqual(["Bot token"]);
    expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toContain(`TELEGRAM_BOT_TOKEN=${GOOD_BOT}`);
    // dev receives by long polling: no webhook secret is asked for or made.
    expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).not.toContain("TELEGRAM_SECRET_TOKEN");
    // The dev worker inherits this process's environment, so the value must be there and not only in the file.
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe(GOOD_BOT);
    expect(said.join("\n")).toContain("telegram has no credentials");

    // The second run has nothing to ask.
    await setUpMissingChannels(dir);
    expect(prompts.asked).toEqual(["Bot token"]);
  });

  it("with no one to ask, refuses naming the command a coding agent runs, and writes nothing", async () => {
    const dir = await telegramAgent();
    interactive = false;
    const error = await outcome(setUpMissingChannels(dir));
    expect(error).toBeInstanceOf(Exit);
    expect((error as Exit).code).toBe(2);
    expect(said.join("\n")).toContain("run `fastagent channels setup telegram --json`");
    expect(prompts.asked).toEqual([]);
    expect(existsSync(join(dir, ".secrets", ".env"))).toBe(false);

    interactive = true;
    const refused = await outcome(setUpMissingChannels(dir, { input: false }));
    expect((refused as Exit).code).toBe(2);
  });
});
