/**
 * The scaffolded send tool delivers through the mounted channel's transport (#458): the channel's
 * credential and `apiBaseUrl`, not a pipeline of its own over the environment. With no channel
 * mounted (`fastagent fire` / `invoke`) it builds one from the env.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent.ts";
import { turnContext } from "../src/engines/pi/tool-context.ts";
import { slackChannel } from "../src/slack.ts";

type Sender = { execute: (id: string, params: unknown) => Promise<{ details: unknown }> };
let sender: Sender;
const roots: string[] = [];

beforeAll(async () => {
  const path = new URL("../src/channels/slack/scaffold/slack-send.ts", import.meta.url).pathname;
  sender = ((await import(path)) as { default: Sender }).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fa-slack-send-"));
  roots.push(dir);
  writeFileSync(join(dir, "fastagent.config.ts"), "");
  return dir;
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

const agent: Agent = {
  async *invoke() {
    yield { type: "completed" };
  },
};

const send = (cwd: string) =>
  turnContext.run({ cwd }, () => sender.execute("call", { channelId: "C1", text: "scheduled update" }));

describe("Slack proactive delivery rides the channel's transport", () => {
  it("sends with the mounted channel's token and API base — the environment is not consulted", async () => {
    vi.stubEnv("FASTAGENT_STATE_DIR", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-from-env");
    const calls = fakeSlack();
    const dir = agentDir();
    slackChannel({ botToken: "xoxb-channel", signingSecret: "s", apiBaseUrl: "https://slack.test/api" })({
      stateRoot: join(dir, ".state"),
      agent,
    });

    await expect(send(dir)).resolves.toMatchObject({ details: "sent message to Slack channel C1 (ts 1.0)" });
    expect(calls.at(-1)).toEqual({
      url: "https://slack.test/api/chat.postMessage",
      authorization: "Bearer xoxb-channel",
    });
  });

  it("with no channel mounted, builds a transport from SLACK_BOT_TOKEN", async () => {
    vi.stubEnv("FASTAGENT_STATE_DIR", "");
    const calls = fakeSlack();
    const dir = agentDir();
    await expect(send(dir)).rejects.toThrow(/SLACK_BOT_TOKEN is not set and no Slack channel is mounted/);

    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-from-env");
    await send(dir);
    expect(calls.at(-1)).toEqual({
      url: "https://slack.com/api/chat.postMessage",
      authorization: "Bearer xoxb-from-env",
    });
  });
});
