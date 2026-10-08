import { defineTool, z } from "@fastagent-sh/fastagent";
import { slackThreads } from "@fastagent-sh/fastagent/slack";

// Reads the threads of the Slack channel this turn was asked in, and no other channel's: the channel names where
// the turn runs, so the tool takes no channel id. It works in a channel turn served by `fastagent dev`/`start`.

export default defineTool({
  description:
    "Read the threads of the Slack channel you are answering in. Without `threadId`, list its recent threads, most " +
    "recently active first, each with its id; with a `threadId` from that list, read that thread. Use it when a " +
    "question here concerns something discussed in another thread, such as whether a problem raised there was " +
    "resolved: the answer is often what a person wrote in the thread. Only this channel's threads can be read, and " +
    "only in a channel turn.",
  input: z.object({
    threadId: z
      .string()
      .optional()
      .describe("a thread id from the list (its first message's ts, like 1712345678.123456); omit it to list"),
  }),
  async execute({ threadId }, ctx) {
    const threads = slackThreads(ctx);
    return threadId === undefined ? threads.list() : threads.read(threadId);
  },
});
