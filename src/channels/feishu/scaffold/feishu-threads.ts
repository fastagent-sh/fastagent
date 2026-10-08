import { defineTool, z } from "@fastagent-sh/fastagent";
import { feishuThreads } from "@fastagent-sh/fastagent/feishu";

// Reads the threads (topics) of the group chat this turn was asked in, and no other chat's: the channel names the
// chat, so the tool takes no chat id. It works in a group chat turn served by `fastagent dev`/`start`.

export default defineTool({
  description:
    "Read the threads (topics) of the Feishu group chat you are answering in. Without `threadId`, list its recent " +
    "threads, newest first, each with its id; with a `threadId` from that list, read that thread. Use " +
    "it when a question here concerns something discussed in a thread, such as whether a problem raised there was " +
    "resolved: the answer is often what a person wrote in the thread. Only this chat's threads can be read, and " +
    "only in a group chat turn.",
  input: z.object({
    threadId: z.string().optional().describe("a thread id from the list (omt_…); omit it to list the threads"),
  }),
  async execute({ threadId }, ctx) {
    const threads = feishuThreads(ctx);
    return threadId === undefined ? threads.list() : threads.read(threadId);
  },
});
