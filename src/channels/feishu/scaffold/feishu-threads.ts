import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { sessionIdOf } from "@fastagent-sh/fastagent";
import { feishuThreads } from "@fastagent-sh/fastagent/feishu";

// Reads the threads (topics) of the Feishu group chat this message was asked in, and no other chat's:
// the channel names where the message runs, so the tool takes no chat id. It works in a group turn
// served by `fastagent dev`/`start`.
export default defineTool({
  name: "feishu_threads",
  description:
    "Read the threads (topics) of the Feishu group chat you are answering in. Without `threadId`, list its recent " +
    "threads, newest first, each with its id; with a `threadId` from that list, read that thread. Use " +
    "it when a question here concerns something discussed in a thread, such as whether a problem raised there was " +
    "resolved: the answer is often what a person wrote in the thread. Only this chat's threads can be read, and " +
    "only in a group chat turn.",
  parameters: Type.Object({
    threadId: Type.Optional(Type.String({ description: "a thread id from the list (omt_…); omit it to list" })),
  }),
  execute: async ({ threadId }, api, context) => {
    const threads = feishuThreads(await sessionIdOf(api, context));
    const text = threadId === undefined ? await threads.list() : await threads.read(threadId);
    return { output: [{ type: "text", text }] };
  },
});
