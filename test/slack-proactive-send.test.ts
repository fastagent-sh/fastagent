/**
 * The scaffolded send tool delivers through the mounted channel's transport (#458): the channel's API base for the
 * bot both hold the token of, not a pipeline of its own. With no channel mounted (`fastagent invoke`) it builds one
 * from its token.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Needs } from "../src/harnesses/pi-durable/define.ts";
import { slackChannel } from "../src/slack.ts";
import { scriptedAgent } from "./scripted-agent.ts";

let sender: Needs<ToolRegistration>;
const roots: string[] = [];

beforeAll(async () => {
  const path = new URL("../src/channels/slack/scaffold/slack-send.ts", import.meta.url).pathname;
  sender = ((await import(path)) as { default: Needs<ToolRegistration> }).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "fa-slack-send-"));
  roots.push(dir);
  return join(dir, ".state");
}

function fakeSlack() {
  const calls: { url: string; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({ ok: true, ts: "1.0", team_id: "T1", user_id: "UBOT" });
  });
  return calls;
}

const send = async (token: string) => {
  const tool = sender.build({ SLACK_BOT_TOKEN: token });
  const result = await tool.execute({ channelId: "C1", text: "scheduled update" } as never, {} as never, {} as never);
  return (result.output?.[0] as { text: string } | undefined)?.text;
};

describe("Slack proactive delivery rides the channel's transport", () => {
  it("sends through the mounted channel of the bot its token signs in as, at that channel's API base", async () => {
    const calls = fakeSlack();
    slackChannel({ botToken: "xoxb-channel", signingSecret: "s", apiBaseUrl: "https://slack.test/api" })({
      stateRoot: stateRoot(),
      agent: scriptedAgent(() => []),
    });

    await expect(send("xoxb-channel")).resolves.toBe("sent message to Slack channel C1 (ts 1.0)");
    expect(calls.at(-1)).toEqual({
      url: "https://slack.test/api/chat.postMessage",
      authorization: "Bearer xoxb-channel",
    });
  });

  it("with no channel mounted for its bot, builds a transport from its token", async () => {
    const calls = fakeSlack();
    await send("xoxb-unmounted");
    expect(calls.at(-1)).toEqual({
      url: "https://slack.com/api/chat.postMessage",
      authorization: "Bearer xoxb-unmounted",
    });
  });

  it("refuses a rotating token, naming the upgrade", async () => {
    fakeSlack();
    await expect(send("xoxe.xoxb-left-in-env")).rejects.toThrow(/rotating Slack bot token.*If token rotation is on/);
  });
});
