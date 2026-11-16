/** The tools a Feishu channel gives the agent: `send`, over the channel's own client, and `threads`. */
import type { ChannelTool } from "../../channel.ts";
import { type RoomThreads, threadsTool } from "../kit/history.ts";
import type { FeishuCloudKind } from "./cloud.ts";
import type { FeishuApi } from "./feishu-api.ts";

interface SendArgs {
  chatId: string;
  text?: string;
  markdown?: string;
}

export function feishuTools(
  kind: FeishuCloudKind,
  api: Pick<FeishuApi, "sendText" | "sendMessage">,
  rooms: () => RoomThreads | undefined,
): ChannelTool[] {
  const platform = kind === "lark" ? "Lark" : "Feishu";
  return [
    {
      name: "send",
      description:
        `Send a message to a ${platform} chat, OUTSIDE the normal reply path. Call it only for a message NO ` +
        "channel is carrying (a scheduled or self-scheduled one, whose plain reply goes " +
        "nowhere) or to reach a chat OTHER than the one you are answering. In a normal chat turn the " +
        "channel streams and delivers your reply itself, so do NOT call this to answer the current " +
        "chat: it would post the message twice, outside the conversation thread. `chatId` (oc_…) names " +
        "the DESTINATION and must come from your instructions (the asking message, the schedule prompt, " +
        `or memory); the [${kind}: chat …] context line only identifies the chat you are answering, the ` +
        "one chat this tool must not target in a chat turn. Pass exactly ONE of `text` (plain) or " +
        "`markdown` (rendered as a card: headings, bold, code blocks, links).",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "string", description: "target chat id (oc_…)" },
          text: { type: "string", description: "plain text message to send" },
          markdown: { type: "string", description: "markdown to send as a card" },
        },
        required: ["chatId"],
        additionalProperties: false,
      },
      async execute(args) {
        const { chatId, text, markdown } = args as unknown as SendArgs;
        if ((text === undefined) === (markdown === undefined)) {
          throw new Error("pass exactly one of `text` (plain) or `markdown` (a card)");
        }
        if (text !== undefined) {
          await api.sendText({ chatId }, text);
          return `sent message to chat ${chatId}`;
        }
        await api.sendMessage(
          chatId,
          "interactive",
          JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "markdown", content: markdown }] } }),
        );
        return `sent card to chat ${chatId}`;
      },
    },
    threadsTool(kind, rooms, {
      description:
        `Read the threads (topics) of the ${platform} group chat you are answering in. Without \`threadId\`, list ` +
        "its recent threads, newest first, each with its id; with a `threadId` from that list, read that thread. " +
        "Use it when a question here concerns something discussed in a thread, such as whether a problem raised " +
        "there was resolved: the answer is often what a person wrote in the thread. Only this chat's threads can " +
        "be read, and only in a group chat turn.",
      threadId: "a thread id from the list (omt_…); omit it to list",
    }),
  ];
}
