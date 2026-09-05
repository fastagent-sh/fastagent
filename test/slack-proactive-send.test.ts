/**
 * The scaffolded send tool and the channel share ONE credential lineage (#458): after the channel
 * rotates the bot token, a proactive send — text or file, channel-first or tool-first, or the two
 * meeting at expiry — posts with the current pair, never the one the environment was booted with.
 */
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent.ts";
import { slackBotAuthPath } from "../src/channels/slack/bot-auth.ts";
import { turnContext } from "../src/engines/pi/tool-context.ts";
import { slackChannel } from "../src/slack.ts";

const SIGNING = "SYNTHETIC-SIGNING";
const INITIAL = "xoxe.xoxb-INITIAL";
const ROTATED = "xoxe.xoxb-ROTATED";
const HALF_DAY = 43_200_000;

type Sender = { execute: (id: string, params: unknown) => Promise<{ details: unknown }> };
let sender: Sender;
const roots: string[] = [];

beforeAll(async () => {
  const path = new URL("../src/channels/slack/scaffold/slack-send.ts", import.meta.url).pathname;
  sender = ((await import(path)) as { default: Sender }).default;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fa-slack-rotation-"));
  roots.push(dir);
  writeFileSync(join(dir, "fastagent.config.ts"), "");
  return dir;
}

/** A Slack that accepts `INITIAL` until `expiresAt`, and `ROTATED` once a refresh has happened. */
function fakeSlack(expiresAt: number, refreshToken: string) {
  const calls: { method: string; authorization: string | null }[] = [];
  let refreshes = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://files.slack.com") return new Response("OK");
    expect(url.origin).toBe("https://slack.com");
    const method = url.pathname.split("/").at(-1) ?? "";
    if (method === "oauth.v2.access") {
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(refreshToken);
      refreshes++;
      return Response.json({ ok: true, access_token: ROTATED, refresh_token: "NEXT-REFRESH", expires_in: 43_200 });
    }
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ method, authorization });
    const valid =
      (authorization === `Bearer ${INITIAL}` && Date.now() < expiresAt) ||
      (authorization === `Bearer ${ROTATED}` && refreshes > 0);
    if (!valid) return Response.json({ ok: false, error: "token_expired" });
    if (method === "auth.test") return Response.json({ ok: true, team_id: "TTEST", user_id: "UBOT" });
    if (method === "files.getUploadURLExternal") {
      return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/x", file_id: "F1" });
    }
    return Response.json({ ok: true, ts: "900.001" });
  });
  return {
    calls,
    refreshes: () => refreshes,
    since: (index: number) => calls.slice(index).map((call) => call.authorization),
  };
}

function mountChannel(stateRoot: string, expiresAt: number) {
  const agent: Agent = {
    async *invoke() {
      yield { type: "text", delta: "Synthetic model reply" };
      yield { type: "completed" };
    },
  };
  const handler = slackChannel({
    botToken: INITIAL,
    signingSecret: SIGNING,
    botRefreshToken: "SYNTHETIC-REFRESH",
    clientId: "SYNTHETIC-CLIENT",
    clientSecret: "SYNTHETIC-SECRET",
    botTokenExpiresAt: expiresAt,
    groupBehavior: "mentions",
    welcome: false,
    reactionAck: false,
  })({ stateRoot, agent })["POST /slack"]!;
  const turnsIdle = (handler as { turnsIdle?: () => Promise<void> }).turnsIdle ?? (async () => {});
  const incoming = async (ts: string): Promise<void> => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "TTEST",
      event_id: `Ev-${ts}`,
      event: { type: "message", channel_type: "im", channel: "DTEST", user: "UTEST", ts, text: "hello" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", SIGNING).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const response = await handler(
      new Request("http://localhost/slack", {
        method: "POST",
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
        body,
      }),
    );
    expect(response.status).toBe(200);
  };
  return { incoming, turnsIdle };
}

const send = (cwd: string, params: Record<string, unknown>) =>
  turnContext.run({ cwd }, () => sender.execute("call", { channelId: "DTEST", ...params }));

describe("Slack proactive delivery shares the channel's rotating credentials", () => {
  it("posts text and uploads files with the pair the channel rotated to — never the boot token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.stubEnv("FASTAGENT_STATE_DIR", "");
    // The boot-time environment, as `add slack` wrote it. 0.20.0's sender read this and nothing else.
    vi.stubEnv("SLACK_BOT_TOKEN", INITIAL);
    const expiresAt = Date.now() + HALF_DAY;
    const slack = fakeSlack(expiresAt, "SYNTHETIC-REFRESH");
    const dir = agentDir();
    const stateRoot = join(dir, ".state");
    const channel = mountChannel(stateRoot, expiresAt);

    await channel.incoming("100.001");
    await channel.turnsIdle();
    await send(dir, { text: "baseline" });
    expect(slack.refreshes()).toBe(0);
    expect(slack.calls.at(-1)).toEqual({ method: "chat.postMessage", authorization: `Bearer ${INITIAL}` });

    vi.setSystemTime(expiresAt + 1_000);
    await channel.incoming("200.001");
    await channel.turnsIdle();
    expect(slack.refreshes()).toBe(1);
    expect(JSON.parse(readFileSync(slackBotAuthPath(stateRoot), "utf8"))).toMatchObject({ accessToken: ROTATED });

    // The 0.20.0 failure: `Bearer ${INITIAL}` from the environment, rejected as token_expired.
    const before = slack.calls.length;
    const file = join(dir, "report.txt");
    writeFileSync(file, "report");
    await expect(send(dir, { text: "scheduled update" })).resolves.toMatchObject({
      details: "sent message to Slack channel DTEST (ts 900.001)",
    });
    await expect(send(dir, { path: file })).resolves.toMatchObject({
      details: "uploaded report.txt to Slack channel DTEST (file F1)",
    });
    expect(slack.calls.slice(before).map((call) => call.method)).toEqual([
      "chat.postMessage",
      "files.getUploadURLExternal",
      "files.completeUploadExternal",
    ]);
    expect(new Set(slack.since(before))).toEqual(new Set([`Bearer ${ROTATED}`]));
  });

  it("with no channel mounted, adopts the newer persisted pair over stale env and rotates it itself", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stateRoot = mkdtempSync(join(tmpdir(), "fa-slack-state-"));
    roots.push(stateRoot);
    vi.stubEnv("FASTAGENT_STATE_DIR", stateRoot); // a non-default root: the tool must follow the same knob
    const persistedExpiry = Date.now() + HALF_DAY;
    const slack = fakeSlack(persistedExpiry, "PERSISTED-REFRESH");
    mkdirSync(join(stateRoot, "channels", "slack"), { recursive: true });
    writeFileSync(
      slackBotAuthPath(stateRoot),
      JSON.stringify({
        version: 1,
        accessToken: INITIAL,
        refreshToken: "PERSISTED-REFRESH",
        expiresAt: persistedExpiry,
      }),
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxe.xoxb-STALE-ENV");
    vi.stubEnv("SLACK_BOT_REFRESH_TOKEN", "STALE-ENV-REFRESH");
    vi.stubEnv("SLACK_CLIENT_ID", "SYNTHETIC-CLIENT");
    vi.stubEnv("SLACK_CLIENT_SECRET", "SYNTHETIC-SECRET");
    vi.stubEnv("SLACK_BOT_TOKEN_EXPIRES_AT", String(persistedExpiry - HALF_DAY));
    const dir = agentDir();

    await send(dir, { text: "first activity after restart" });
    expect(slack.refreshes()).toBe(0);
    expect(slack.calls.at(-1)?.authorization).toBe(`Bearer ${INITIAL}`);

    vi.setSystemTime(persistedExpiry + 1_000);
    await send(dir, { text: "after expiry" });
    expect(slack.refreshes()).toBe(1);
    expect(slack.calls.at(-1)?.authorization).toBe(`Bearer ${ROTATED}`);
    expect(JSON.parse(readFileSync(slackBotAuthPath(stateRoot), "utf8"))).toMatchObject({
      accessToken: ROTATED,
      refreshToken: "NEXT-REFRESH",
    });
  });

  it("a channel turn and a tool send meeting at expiry refresh once, and both post with the new pair", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.stubEnv("FASTAGENT_STATE_DIR", "");
    const expiresAt = Date.now() + HALF_DAY;
    const slack = fakeSlack(expiresAt, "SYNTHETIC-REFRESH");
    const dir = agentDir();
    const channel = mountChannel(join(dir, ".state"), expiresAt);
    await channel.incoming("100.001"); // auth.test + one turn before expiry
    await channel.turnsIdle();

    vi.setSystemTime(expiresAt + 1_000);
    const before = slack.calls.length;
    await Promise.all([channel.incoming("200.001"), send(dir, { text: "concurrent proactive send" })]);
    await channel.turnsIdle();
    expect(slack.refreshes()).toBe(1);
    expect(slack.calls.slice(before).map((call) => call.method)).toContain("chat.postMessage");
    expect(slack.calls.slice(before).map((call) => call.method)).toContain("chat.stopStream");
    expect(new Set(slack.since(before))).toEqual(new Set([`Bearer ${ROTATED}`]));
  });
});
