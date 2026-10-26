import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { needs } from "@fastagent-sh/fastagent";
import { feishuTransport } from "@fastagent-sh/fastagent/feishu";

// Proactive delivery uses the mounted channel's credentials, gateway and token cache. With no
// channel mounted, it signs in with FEISHU_APP_ID / FEISHU_APP_SECRET itself.
export default needs(["FEISHU_APP_ID", "FEISHU_APP_SECRET"], (secrets) =>
  defineTool({
    name: "feishu_send",
    description:
      "Send a message to a Feishu chat, OUTSIDE the normal reply path. Call it only for a message NO " +
      "channel is carrying (a scheduled or self-scheduled one, whose plain reply goes " +
      "nowhere) or to reach a chat OTHER than the one you are answering. In a normal chat turn the " +
      "channel streams and delivers your reply itself, so do NOT call this to answer the current " +
      "chat: it would post the message twice, outside the conversation thread. `chatId` (oc_…) names " +
      "the DESTINATION and must come from your instructions (the asking message, the schedule prompt, " +
      "or memory); the [feishu: chat …] context line only identifies the chat you are answering, the " +
      "one chat this tool must not target in a chat turn. Pass exactly ONE of `text` (plain) or " +
      "`markdown` (rendered as a card: headings, bold, code blocks, links).",
    parameters: Type.Object({
      chatId: Type.String({ description: "target chat id (oc_…)" }),
      text: Type.Optional(Type.String({ description: "plain text message to send" })),
      markdown: Type.Optional(Type.String({ description: "markdown to send as a card" })),
    }),
    execute: async ({ chatId, text, markdown }) => {
      if ((text === undefined) === (markdown === undefined)) {
        throw new Error("pass exactly one of `text` (plain) or `markdown` (a card)");
      }
      const api = feishuTransport({ appId: secrets.FEISHU_APP_ID, appSecret: secrets.FEISHU_APP_SECRET });
      if (text !== undefined) await api.sendText({ chatId }, text);
      else {
        await api.sendMessage(
          chatId,
          "interactive",
          JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "markdown", content: markdown }] } }),
        );
      }
      return { output: [{ type: "text", text: `sent ${text !== undefined ? "message" : "card"} to chat ${chatId}` }] };
    },
  }),
);
