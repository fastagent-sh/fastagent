import { defineTool, z } from "@fastagent-sh/fastagent";

// Send a message to a Feishu chat. In a CHAT turn the channel delivers the reply itself — this
// tool is for turns NO channel is carrying: a scheduled turn (schedules/<name>.ts) or a self-scheduled
// wake-up, whose plain reply is not delivered anywhere. The chatId comes from the [feishu: chat …]
// context line in a chat turn; a scheduled turn has no such line, so the schedule's prompt must name
// the target chat id. tools/ is auto-discovered.

// Embedded copy of the channel transport's discipline: a timeout so a wedged connection can't hang
// the tool call (and the turn), named errors, and success gated on the body's own code===0.
// Deliberately NO rate-limit retry — a tool error goes back to the agent, which can decide to retry;
// fail-fast beats a silently sleeping tool.
const BASE = "https://open.feishu.cn";

async function callApi(path: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  let res: Response;
  let raw: string;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    raw = await res.text();
  } catch (e) {
    throw new Error(`feishu ${path}: ${String(e)}`, { cause: e });
  }
  let data: { code?: number; msg?: string; [k: string]: unknown };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    data = {};
  }
  if (!res.ok || data.code !== 0) {
    throw new Error(`feishu ${path} failed: ${res.status} ${data.msg ?? "response was not the expected JSON"}`);
  }
  return data;
}

async function tenantToken(): Promise<string> {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET are not set");
  const data = await callApi("/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: appId,
    app_secret: appSecret,
  });
  const token = data.tenant_access_token;
  if (typeof token !== "string") throw new Error("feishu tenant_access_token: response carried no token");
  return token;
}

export default defineTool({
  description:
    "Send a message to a Feishu chat: plain `text`, or `markdown` (rendered as a card — headings, " +
    "bold, code blocks, links). Exactly one of the two. In a chat turn take chatId from the " +
    "[feishu: chat …] context line; in a scheduled/woken turn (no context line) the chat id must come " +
    "from your instruction.",
  input: z.object({
    chatId: z.string().describe("target chat id (oc_…)"),
    text: z.string().optional().describe("plain text message to send"),
    markdown: z.string().optional().describe("markdown to send as a card"),
  }),
  async execute({ chatId, text, markdown }) {
    if ((text === undefined) === (markdown === undefined)) {
      throw new Error("pass exactly one of `text` (plain) or `markdown` (a card)");
    }
    const token = await tenantToken();
    const msg =
      text !== undefined
        ? { msg_type: "text", content: JSON.stringify({ text }) }
        : {
            msg_type: "interactive",
            // An inline static card: one markdown element, no entity/streaming machinery needed here.
            content: JSON.stringify({
              schema: "2.0",
              body: { elements: [{ tag: "markdown", content: markdown }] },
            }),
          };
    await callApi(`/open-apis/im/v1/messages?receive_id_type=chat_id`, { receive_id: chatId, ...msg }, token);
    return `sent ${text !== undefined ? "message" : "card"} to chat ${chatId}`;
  },
});
