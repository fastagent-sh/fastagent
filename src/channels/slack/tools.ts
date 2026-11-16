/** The tools a Slack channel gives the agent: `send`, over the channel's own client, and `threads`. */
import type { ChannelTool } from "../../channel.ts";
import { type RoomThreads, threadsTool } from "../kit/history.ts";
import type { SlackApi } from "./slack-api.ts";

interface SendArgs {
  channelId: string;
  text?: string;
  path?: string;
  title?: string;
  initialComment?: string;
  threadTs?: string;
}

export function slackTools(slack: SlackApi, rooms: () => RoomThreads | undefined): ChannelTool[] {
  return [
    {
      name: "send",
      description:
        "Upload one local file to Slack (`path`), or send a message (`text`) for a message NO channel is " +
        "carrying: a scheduled or self-scheduled one. In a normal chat turn the channel already " +
        "delivers your reply, so do NOT call this to answer (it would post the message twice). Pass exactly " +
        "one of `text`/`path`. channelId/threadTs come from the [slack: …] context line in a chat turn; a " +
        "scheduled or woken message has no context line, so name the destination in your instruction. A user ID " +
        "(U…) as channelId messages that user's DM; a file upload needs the DM channel ID (D…) the text send reports.",
      parameters: {
        type: "object",
        properties: {
          channelId: {
            type: "string",
            description: "target Slack channel ID, or a user ID (U…) to message that user's DM",
          },
          text: { type: "string", description: "standard Markdown message text" },
          path: { type: "string", description: "absolute path of a local file to upload" },
          title: { type: "string", description: "file title (file mode only)" },
          initialComment: { type: "string", description: "message posted with the file (file mode only)" },
          threadTs: { type: "string", description: "thread parent timestamp, if replying in a thread" },
        },
        required: ["channelId"],
        additionalProperties: false,
      },
      async execute(args) {
        const { channelId, text, path, title, initialComment, threadTs } = args as unknown as SendArgs;
        if ((text === undefined) === (path === undefined)) throw new Error("pass exactly one of `text` or `path`");
        const target = { channelId, ...(threadTs === undefined ? {} : { threadTs }) };
        if (text !== undefined) {
          if (title !== undefined || initialComment !== undefined) {
            throw new Error("`title`/`initialComment` are file-mode only");
          }
          const sent = await slack.sendMarkdown(target, text);
          // A user-id target reports the DM channel Slack resolved it to: the id a file upload needs.
          return sent.channelId === channelId
            ? `sent message to Slack channel ${channelId} (ts ${sent.ts})`
            : `sent message to Slack user ${channelId} in DM channel ${sent.channelId} (ts ${sent.ts})`;
        }
        const file = await slack.uploadFile(target, path as string, {
          ...(title === undefined ? {} : { title }),
          ...(initialComment === undefined ? {} : { initialComment }),
        });
        return `uploaded ${file.name} to Slack channel ${channelId} (file ${file.id})`;
      },
    },
    threadsTool("slack", rooms, {
      description:
        "Read the threads of the Slack channel you are answering in. Without `threadId`, list its recent threads, " +
        "most recently active first, each with its id; with a `threadId` from that list, read that thread. Use it " +
        "when a question here concerns something discussed in another thread, such as whether a problem raised " +
        "there was resolved: the answer is often what a person wrote in the thread. Only this channel's threads " +
        "can be read, and only in a channel turn.",
      threadId: "a thread id from the list (its first message's ts, like 1712345678.123456); omit it to list",
    }),
  ];
}
