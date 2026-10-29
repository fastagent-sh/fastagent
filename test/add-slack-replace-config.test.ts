/**
 * `add slack --replace-config`: the non-interactive repair path. The flag must skip the menus
 * (select is never shown), replace ONLY the local App Configuration token pair, and fail visibly
 * when there is no local onboarding state to repair.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({
  passwordAnswers: [] as string[],
  select: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  isCancel: () => false,
  log: { info: vi.fn() },
  password: vi.fn(async () => {
    const next = prompts.passwordAnswers.shift();
    if (next === undefined) throw new Error("test: unexpected password prompt");
    return next;
  }),
  select: prompts.select,
  text: vi.fn(async () => {
    throw new Error("test: unexpected text prompt");
  }),
}));
vi.mock("../src/open-url.ts", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));
// The resume path continues into app installation after replacing tokens; stop it at the setup
// server with a sentinel so the test proves both "tokens persisted" and "resume continued".
vi.mock("../src/channels/slack/setup-server.ts", () => ({
  startSlackSetupServer: vi.fn(async () => {
    throw new Error("SENTINEL: setup server reached");
  }),
}));

import { onboardSlackInternalApp, slackTokenHandoffPath, slackTokensForAgent } from "../src/cli/add-slack.ts";
import { writeSlackOnboardingState } from "../src/channels/slack/onboarding-state.ts";

const RUNTIME_ENV = ["SLACK_BOT_TOKEN=xoxb-runtime", "SLACK_SIGNING_SECRET=signing"].join("\n");

describe("add slack --replace-config", () => {
  let target: string;
  let stateRoot: string;

  beforeEach(async () => {
    target = await mkdtemp(join(tmpdir(), "fa-slack-rc-"));
    stateRoot = join(target, ".state");
    await mkdir(join(target, ".secrets"), { recursive: true });
    prompts.passwordAnswers.length = 0;
    prompts.select.mockClear();
    // isTTY is a plain data property (undefined under vitest) — assign, restore in afterEach.
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
  });

  afterEach(async () => {
    process.stdin.isTTY = undefined as unknown as boolean;
    process.stdout.isTTY = undefined as unknown as boolean;
    vi.restoreAllMocks();
    await rm(target, { recursive: true, force: true });
  });

  const run = () =>
    onboardSlackInternalApp({
      target,
      stateRoot,
      replaceConfig: true,
    });

  const readState = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(stateRoot, "channels", "slack", "onboarding.json"), "utf8"));

  it("fails visibly when there is no local onboarding state to replace", async () => {
    await expect(run()).rejects.toThrow(/--replace-config found no local Slack onboarding state/);
    expect(prompts.select).not.toHaveBeenCalled();
  });

  it("installed app: skips the menu, replaces only the config token pair, leaves runtime credentials alone", async () => {
    await writeFile(join(target, ".secrets", ".env"), RUNTIME_ENV);
    writeSlackOnboardingState(stateRoot, {
      version: 1,
      appName: "App",
      appId: "A1",
      configToken: "xoxe.xoxp-old",
      configRefreshToken: "xoxe-old",
      configTokenExpiresAt: 1,
      teamId: "T1",
      installedAt: "2026-01-01T00:00:00.000Z",
    });
    prompts.passwordAnswers.push("xoxe.xoxp-new", "xoxe-new");
    await run();
    expect(prompts.select).not.toHaveBeenCalled();
    const state = await readState();
    expect(state.configToken).toBe("xoxe.xoxp-new");
    expect(state.configRefreshToken).toBe("xoxe-new");
    expect(state.appId).toBe("A1");
    expect(state.installedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(await readFile(join(target, ".secrets", ".env"), "utf8")).toBe(RUNTIME_ENV); // untouched
  });

  it("installed app: rejects a token pair with the wrong prefixes", async () => {
    await writeFile(join(target, ".secrets", ".env"), RUNTIME_ENV);
    writeSlackOnboardingState(stateRoot, {
      version: 1,
      appName: "App",
      appId: "A1",
      configToken: "xoxe.xoxp-old",
      configRefreshToken: "xoxe-old",
      configTokenExpiresAt: 1,
      installedAt: "2026-01-01T00:00:00.000Z",
    });
    prompts.passwordAnswers.push("wrong-prefix", "also-wrong");
    await expect(run()).rejects.toThrow(/invalid Slack configuration token prefix/);
    expect((await readState()).configToken).toBe("xoxe.xoxp-old"); // nothing persisted
  });

  it("created-but-not-installed app: replaces tokens without a menu, then resumes installation", async () => {
    writeSlackOnboardingState(stateRoot, {
      version: 1,
      appName: "App",
      appId: "A1", // created, never installed — the state a revoked token would otherwise strand
      configToken: "xoxe.xoxp-old",
      configRefreshToken: "xoxe-old",
      configTokenExpiresAt: 1,
    });
    prompts.passwordAnswers.push("xoxe.xoxp-new", "xoxe-new");
    // Collected into an array rather than read off `spy.mock.calls` afterwards: `mockRestore()`
    // clears the recorded calls, so an assertion below the restore reads an empty list — silently,
    // and a `not.toContain` written that way would pass forever.
    const printed: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      printed.push(args.join(" "));
    });
    try {
      await expect(run()).rejects.toThrow(/SENTINEL: setup server reached/);
    } finally {
      spy.mockRestore();
    }
    expect(prompts.select).not.toHaveBeenCalled();
    const state = await readState();
    expect(state.configToken).toBe("xoxe.xoxp-new");
    expect(state.configRefreshToken).toBe("xoxe-new");
    // The page the operator is about to paste a token FROM. `openExternalUrl` swallows its spawn
    // error, so on a headless box this line is the only way to reach it — asserted on what the
    // operator actually sees, not on the source text that produces it.
    expect(printed.join("\n")).toContain("https://api.slack.com/apps");
  });
});

describe("add slack through a coding agent's person", () => {
  let target: string;
  let stateRoot: string;

  beforeEach(async () => {
    target = await mkdtemp(join(tmpdir(), "fa-slack-agent-"));
    stateRoot = join(target, ".state");
    await mkdir(join(target, ".secrets"), { recursive: true });
    prompts.passwordAnswers.length = 0;
    prompts.select.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(target, { recursive: true, force: true });
  });

  const handOff = async (text: string) => {
    await mkdir(join(stateRoot, "channels", "slack"), { recursive: true });
    await writeFile(slackTokenHandoffPath(stateRoot), text);
  };
  const readState = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(stateRoot, "channels", "slack", "onboarding.json"), "utf8"));
  const person = { waitsOn: vi.fn(), carriesOn: vi.fn(), afterwards: vi.fn() };

  it("waits for the token pair, then takes it from the handoff file into its state and deletes the file", async () => {
    expect(await slackTokensForAgent(target, stateRoot, false)).toBe("needs-handoff");
    await handOff("SLACK_CONFIG_TOKEN=xoxe.xoxp-1\nSLACK_CONFIG_REFRESH_TOKEN=xoxe-1\n");
    expect(await slackTokensForAgent(target, stateRoot, false)).toBe("ready");
    expect(await readState()).toMatchObject({
      appName: `FastAgent ${basename(target)}`,
      configToken: "xoxe.xoxp-1",
      configRefreshToken: "xoxe-1",
    });
    await expect(readFile(slackTokenHandoffPath(stateRoot))).rejects.toThrow(/ENOENT/);
  });

  it("refuses a handoff file that holds no token pair, by its path, and keeps it for the person to fix", async () => {
    await handOff("SLACK_CONFIG_TOKEN=xoxb-wrong\n");
    await expect(slackTokensForAgent(target, stateRoot, false)).rejects.toThrow(
      `invalid Slack configuration token prefix (expected xoxe. access + xoxe- refresh) in ${slackTokenHandoffPath(stateRoot)}`,
    );
    expect(await readFile(slackTokenHandoffPath(stateRoot), "utf8")).toContain("xoxb-wrong");
  });

  it("an installed app needs no pair; --replace-config takes a fresh one, and with no state refuses as at a terminal", async () => {
    await expect(slackTokensForAgent(target, stateRoot, true)).rejects.toThrow(
      /--replace-config found no local Slack onboarding state/,
    );
    writeSlackOnboardingState(stateRoot, {
      version: 1,
      appName: "App",
      appId: "A1",
      configToken: "xoxe.xoxp-old",
      configRefreshToken: "xoxe-old",
      configTokenExpiresAt: 1,
      installedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await slackTokensForAgent(target, stateRoot, false)).toBe("ready");
    expect(await slackTokensForAgent(target, stateRoot, true)).toBe("needs-handoff");
    await handOff("SLACK_CONFIG_TOKEN=xoxe.xoxp-new\nSLACK_CONFIG_REFRESH_TOKEN=xoxe-new\n");
    expect(await slackTokensForAgent(target, stateRoot, true)).toBe("ready");
    expect(await readState()).toMatchObject({ appId: "A1", configToken: "xoxe.xoxp-new" });
  });

  it("asks nothing: a saved pair is kept, and a run with no pair is refused", async () => {
    await expect(onboardSlackInternalApp({ target, stateRoot, person })).rejects.toThrow(
      /no Slack App Configuration token pair/,
    );
    // Not created yet: the resume where a terminal asks which token pair to use.
    writeSlackOnboardingState(stateRoot, {
      version: 1,
      appName: "App",
      configToken: "xoxe.xoxp-old",
      configRefreshToken: "xoxe-old",
      configTokenExpiresAt: 1,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(onboardSlackInternalApp({ target, stateRoot, person })).rejects.toThrow(/SENTINEL/);
    expect(prompts.select).not.toHaveBeenCalled();
  });
});
