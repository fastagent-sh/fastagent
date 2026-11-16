/**
 * The `send` tool each first-party channel gives the agent, as `fastagent.config.ts` declares the channel: built with
 * the variables it reads, and delivering over that channel's own bot or app.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, ChannelTool } from "../../../src/channel.ts";
import { feishu } from "../../../src/feishu.ts";
import type { Needs } from "../../../src/needs.ts";
import { slack } from "../../../src/slack.ts";
import { telegram } from "../../../src/telegram.ts";

afterEach(() => vi.unstubAllGlobals());

function sendTool(declared: Needs<Channel>, values: Record<string, string>): ChannelTool {
  const tool = declared.build(values).tools?.find(({ name }) => name === "send");
  if (tool === undefined) throw new Error("the channel gives no send tool");
  return tool;
}

/** Every request the platform is sent, answered the way `answer` says. */
function stubFetch(answer: (url: string, body: Record<string, unknown>) => unknown) {
  const calls: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), body });
    return Response.json(answer(url, body));
  });
  return calls;
}

describe("a channel's send tool", () => {
  it("telegram: sends with TELEGRAM_BOT_TOKEN, and says the chat's history will not show it while not serving", async () => {
    const calls = stubFetch((_url, body) => ({ ok: true, result: { message_id: 101, chat: { id: body.chat_id } } }));
    const said = await sendTool(telegram(), { TELEGRAM_BOT_TOKEN: "tok" }).execute(
      { chatId: 42, text: "digest ready" },
      {},
    );
    expect(calls[0]?.url).toBe("https://api.telegram.org/bottok/sendMessage");
    expect(calls[0]?.body).toMatchObject({ chat_id: 42, text: "digest ready" });
    expect(said).toBe(
      "sent message to chat 42; not recorded: the telegram channel is not serving in this process, so the chat's " +
        "history will not show it",
    );
  });

  it("slack: posts Markdown with SLACK_BOT_TOKEN to the channel and thread named", async () => {
    const calls = stubFetch(() => ({ ok: true, ts: "1.0" }));
    const said = await sendTool(slack(), { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test" }).execute(
      { channelId: "C1", threadTs: "9.0", text: "hello" },
      {},
    );
    expect(calls[0]).toMatchObject({
      url: "https://slack.com/api/chat.postMessage",
      authorization: "Bearer xoxb-test",
      body: { channel: "C1", thread_ts: "9.0", markdown_text: "hello" },
    });
    expect(said).toBe("sent message to Slack channel C1 (ts 1.0)");
  });

  it.each([
    { domain: "feishu", prefix: "FEISHU", base: "https://open.feishu.cn" },
    { domain: "lark", prefix: "LARK", base: "https://open.larksuite.com" },
  ] as const)(
    "feishu, domain $domain: sends as the app the $prefix_* variables name, on its cloud",
    async ({ domain, prefix, base }) => {
      const calls = stubFetch((url, body) =>
        url.includes("tenant_access_token")
          ? { code: 0, tenant_access_token: `t-${String(body.app_id)}`, expire: 7200 }
          : { code: 0, data: { message_id: "om_1" } },
      );
      const tool = sendTool(feishu({ domain }), { [`${prefix}_APP_ID`]: "cli_1", [`${prefix}_APP_SECRET`]: "s" });
      expect(await tool.execute({ chatId: "oc_42", text: "digest ready" }, {})).toBe("sent message to chat oc_42");
      expect(calls[0]?.body).toEqual({ app_id: "cli_1", app_secret: "s" });
      expect(calls[1]).toEqual({
        url: `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        authorization: "Bearer t-cli_1",
        body: { receive_id: "oc_42", msg_type: "text", content: JSON.stringify({ text: "digest ready" }) },
      });
    },
  );
});
