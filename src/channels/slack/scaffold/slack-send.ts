import { defineTool, z } from "@fastagent-sh/fastagent";
import { slackTransport } from "@fastagent-sh/fastagent/slack";

// Send a message or upload a local file to Slack. In a CHAT turn the channel delivers the reply
// itself — do NOT call this to answer a normal chat turn (that posts the message twice). This tool is
// for file uploads, and for turns NO channel is carrying: a scheduled turn (schedules/<name>.ts) or a
// self-scheduled wake-up, whose plain reply is not delivered anywhere. The channelId/threadTs come
// from the [slack: …] context line in a chat turn; a scheduled/woken turn has no such line, so its
// prompt must name the target channel id. tools/ is auto-discovered.
//
// Delivery rides the channel's own transport and credentials (slackTransport): the rotating bot token
// the channel refreshed is the one this tool sends with. With no channel mounted (`fastagent fire` /
// `invoke`) it is built from .env over the same persisted pair, so rotation stays one lineage.

export default defineTool({
  description:
    "Upload one local file to Slack (`path`), or send a message (`text`) for a turn NO channel is " +
    "carrying — a scheduled or self-scheduled (wake) turn. In a normal chat turn the channel already " +
    "delivers your reply, so do NOT call this to answer (it would post the message twice). Pass exactly " +
    "one of `text`/`path`. channelId/threadTs come from the [slack: …] context line in a chat turn; a " +
    "scheduled/woken turn has no context line, so name the destination in your instruction.",
  input: z.object({
    channelId: z.string().describe("target Slack channel ID"),
    text: z.string().optional().describe("standard Markdown message text"),
    path: z.string().optional().describe("absolute path of a local file to upload"),
    title: z.string().optional().describe("file title (file mode only)"),
    initialComment: z.string().optional().describe("message posted with the file (file mode only)"),
    threadTs: z.string().optional().describe("thread parent timestamp, if replying in a thread"),
  }),
  async execute({ channelId, text, path, title, initialComment, threadTs }, ctx) {
    if ((text === undefined) === (path === undefined)) throw new Error("pass exactly one of `text` or `path`");
    const slack = slackTransport(ctx.cwd);
    const target = { channelId, threadTs };
    if (text !== undefined) {
      if (title !== undefined || initialComment !== undefined) {
        throw new Error("`title`/`initialComment` are file-mode only");
      }
      const ts = await slack.sendMarkdown(target, text);
      return `sent message to Slack channel ${channelId} (ts ${ts})`;
    }
    const file = await slack.uploadFile(target, path as string, { title, initialComment });
    return `uploaded ${file.name} to Slack channel ${channelId} (file ${file.id})`;
  },
});
