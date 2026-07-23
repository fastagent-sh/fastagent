/**
 * `add slack --replace-config`: the non-interactive repair path. The flag must skip the menus
 * (select is never shown), replace ONLY the local App Configuration token pair, and fail visibly
 * when there is no local onboarding state to repair.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { onboardSlackInternalApp } from "../src/cli/add-slack.ts";
import { writeSlackOnboardingState } from "../src/channels/slack/onboarding-state.ts";

const RUNTIME_ENV = [
  "SLACK_BOT_TOKEN=xoxe.xoxb-runtime",
  "SLACK_BOT_REFRESH_TOKEN=xoxe-runtime-refresh",
  "SLACK_BOT_TOKEN_EXPIRES_AT=2000000000000",
  "SLACK_CLIENT_ID=client",
  "SLACK_CLIENT_SECRET=secret",
  "SLACK_SIGNING_SECRET=signing",
].join("\n");

describe("add slack --replace-config", () => {
  let target: string;
  let stateRoot: string;

  beforeEach(async () => {
    target = await mkdtemp(join(tmpdir(), "fa-slack-rc-"));
    stateRoot = join(target, ".fastagent");
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
      envIgnored: true,
      groupBehavior: { behavior: "context", explicit: false },
      replaceConfig: true,
    });

  const readState = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(stateRoot, "channels", "slack", "onboarding.json"), "utf8"));

  it("fails visibly when there is no local onboarding state to replace", async () => {
    await expect(run()).rejects.toThrow(/--replace-config found no local Slack onboarding state/);
    expect(prompts.select).not.toHaveBeenCalled();
  });

  it("installed app: skips the menu, replaces only the config token pair, leaves runtime credentials alone", async () => {
    await writeFile(join(target, ".env"), RUNTIME_ENV);
    await writeSlackOnboardingState(stateRoot, {
      version: 1,
      appName: "App",
      groupBehavior: "context",
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
    expect(await readFile(join(target, ".env"), "utf8")).toBe(RUNTIME_ENV); // untouched
  });

  it("installed app: rejects a token pair with the wrong prefixes", async () => {
    await writeFile(join(target, ".env"), RUNTIME_ENV);
    await writeSlackOnboardingState(stateRoot, {
      version: 1,
      appName: "App",
      groupBehavior: "context",
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
    await writeSlackOnboardingState(stateRoot, {
      version: 1,
      appName: "App",
      groupBehavior: "context",
      appId: "A1", // created, never installed — the state a revoked token would otherwise strand
      configToken: "xoxe.xoxp-old",
      configRefreshToken: "xoxe-old",
      configTokenExpiresAt: 1,
    });
    prompts.passwordAnswers.push("xoxe.xoxp-new", "xoxe-new");
    await expect(run()).rejects.toThrow(/SENTINEL: setup server reached/);
    expect(prompts.select).not.toHaveBeenCalled();
    const state = await readState();
    expect(state.configToken).toBe("xoxe.xoxp-new");
    expect(state.configRefreshToken).toBe("xoxe-new");
  });
});
