import { defineTool, z } from "@fastagent-sh/fastagent";
import { larkTransport } from "@fastagent-sh/fastagent/lark";

// Proactive delivery uses the mounted channel's credentials, gateway and token cache. With no
// channel mounted (fire/invoke/tool), it reads LARK_APP_ID / LARK_APP_SECRET from the environment.

export default defineTool({
  description:
    "Send a message to a Lark chat, OUTSIDE the normal reply path. Call it only for a turn NO " +
    "channel is carrying — a scheduled or self-scheduled (wake) turn, whose plain reply goes " +
    "nowhere — or to reach a chat OTHER than the one you are answering. In a normal chat turn the " +
    "channel streams and delivers your reply itself, so do NOT call this to answer the current " +
    "chat: it would post the message twice, outside the conversation thread. `chatId` (oc_…) names " +
    "the DESTINATION and must come from your instructions (the asking message, the schedule prompt, " +
    "or memory); the [lark: chat …] context line only identifies the chat you are answering — the " +
    "one chat this tool must not target in a chat turn. Pass exactly ONE of `text` (plain) or " +
    "`markdown` (rendered as a card: headings, bold, code blocks, links).",
  input: z.object({
    chatId: z.string().describe("target chat id (oc_…)"),
    text: z.string().optional().describe("plain text message to send"),
    markdown: z.string().optional().describe("markdown to send as a card"),
  }),
  async execute({ chatId, text, markdown }, ctx) {
    if ((text === undefined) === (markdown === undefined)) {
      throw new Error("pass exactly one of `text` (plain) or `markdown` (a card)");
    }
    const api = larkTransport(ctx.cwd);
    if (text !== undefined) await api.sendText({ chatId }, text);
    else {
      await api.sendMessage(chatId, "interactive", JSON.stringify({
        schema: "2.0",
        body: { elements: [{ tag: "markdown", content: markdown }] },
      }));
    }
    return `sent ${text !== undefined ? "message" : "card"} to chat ${chatId}`;
  },
});
