import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { needs } from "@fastagent-sh/fastagent";
import { slackTransport } from "@fastagent-sh/fastagent/slack";

// Send a message or upload a local file to Slack. In a CHAT turn the channel delivers the reply
// itself: do NOT call this to answer a normal chat turn (that posts the message twice). This tool is
// for file uploads, and for messages NO channel is carrying: a schedule's (src/schedules/) or a
// self-scheduled wake-up's, whose plain reply is not delivered anywhere. The channelId/threadTs come
// from the [slack: …] context line in a chat turn; a scheduled or woken message has no such line, so
// its prompt must name the target channel id.
//
// Delivery rides the channel's own transport (slackTransport): its token, API base, Markdown
// splitting and rate-limit handling. With no channel mounted, it is built from SLACK_BOT_TOKEN.
export default needs(["SLACK_BOT_TOKEN"], ({ SLACK_BOT_TOKEN }) =>
  defineTool({
    name: "slack_send",
    description:
      "Upload one local file to Slack (`path`), or send a message (`text`) for a message NO channel is " +
      "carrying: a scheduled or self-scheduled one. In a normal chat turn the channel already " +
      "delivers your reply, so do NOT call this to answer (it would post the message twice). Pass exactly " +
      "one of `text`/`path`. channelId/threadTs come from the [slack: …] context line in a chat turn; a " +
      "scheduled or woken message has no context line, so name the destination in your instruction. A user ID " +
      "(U…) as channelId messages that user's DM; a file upload needs the DM channel ID (D…) the text send reports.",
    parameters: Type.Object({
      channelId: Type.String({ description: "target Slack channel ID, or a user ID (U…) to message that user's DM" }),
      text: Type.Optional(Type.String({ description: "standard Markdown message text" })),
      path: Type.Optional(Type.String({ description: "absolute path of a local file to upload" })),
      title: Type.Optional(Type.String({ description: "file title (file mode only)" })),
      initialComment: Type.Optional(Type.String({ description: "message posted with the file (file mode only)" })),
      threadTs: Type.Optional(Type.String({ description: "thread parent timestamp, if replying in a thread" })),
    }),
    execute: async ({ channelId, text, path, title, initialComment, threadTs }) => {
      if ((text === undefined) === (path === undefined)) throw new Error("pass exactly one of `text` or `path`");
      const slack = slackTransport(SLACK_BOT_TOKEN);
      const target = { channelId, threadTs };
      let said: string;
      if (text !== undefined) {
        if (title !== undefined || initialComment !== undefined) {
          throw new Error("`title`/`initialComment` are file-mode only");
        }
        const sent = await slack.sendMarkdown(target, text);
        // A user-id target reports the DM channel Slack resolved it to: the id a file upload needs.
        said =
          sent.channelId === channelId
            ? `sent message to Slack channel ${channelId} (ts ${sent.ts})`
            : `sent message to Slack user ${channelId} in DM channel ${sent.channelId} (ts ${sent.ts})`;
      } else {
        const file = await slack.uploadFile(target, path as string, { title, initialComment });
        said = `uploaded ${file.name} to Slack channel ${channelId} (file ${file.id})`;
      }
      return { output: [{ type: "text", text: said }] };
    },
  }),
);
