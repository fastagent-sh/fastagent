import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentEvent, Prompt } from "../src/agent.ts";
import { invokeSlackTurn } from "../src/channels/slack/invoke-turn.ts";
import type { SlackApi } from "../src/channels/slack/slack-api.ts";

function fakeApi(overrides: Partial<SlackApi> = {}): SlackApi {
  return {
    authTest: async () => ({}),
    postMessage: async () => "1.0",
    postMarkdown: async () => "1.0",
    updateMessage: async () => {},
    updateMarkdown: async () => {},
    deleteMessage: async () => {},
    sendMarkdown: async () => "1.0",
    startStream: async () => "1.0",
    appendStream: async () => {},
    stopStream: async () => {},
    setThreadStatus: async () => {},
    setThreadTitle: async () => {},
    addReaction: async () => {},
    removeReaction: async () => {},
    fileInfo: async (id) => ({
      id,
      name: `${id}.txt`,
      mimetype: "text/plain",
      url_private: "https://files.slack.com/x",
    }),
    fetchImage: async () => ({ mimeType: "image/png", data: "aW1n" }),
    fetchFile: async (file) => ({ path: `/state/${file.id}.txt`, name: `${file.id}.txt`, size: 4 }),
    ...overrides,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("Slack turn attachment resolution", () => {
  it("turns primary images into vision input and ordinary files into an absolute-path manifest", async () => {
    let prompt: Prompt | undefined;
    const agent: Agent = {
      async *invoke(_scope, value): AsyncIterable<AgentEvent> {
        prompt = value;
        yield { type: "completed" };
      },
    };
    const api = fakeApi({
      fileInfo: async (id) => ({ id, name: `${id}.dat`, mimetype: id === "IMG" ? "image/png" : "text/plain" }),
    });
    const completed = vi.fn();

    const events = await collect(
      invokeSlackTurn(
        agent,
        "s1",
        "read these",
        { api, channelId: "C1", filesDir: "/state", label: "[slack]" },
        { primaryFileIds: ["IMG", "DOC"], buffered: { files: [], skipped: 0 } },
        completed,
      ),
    );

    expect(events.at(-1)).toEqual({ type: "completed" });
    expect(prompt?.images).toEqual([{ mimeType: "image/png", data: "aW1n" }]);
    expect(prompt?.text).toContain("/state/DOC.txt");
    expect(completed).toHaveBeenCalledOnce();
  });

  it("turns a primary file failure into failed without invoking the Agent", async () => {
    const invoke = vi.fn();
    const agent = { invoke } as unknown as Agent;
    const api = fakeApi({ fileInfo: async () => Promise.reject(new Error("access_denied")) });

    const events = await collect(
      invokeSlackTurn(
        agent,
        "s1",
        "read it",
        { api, channelId: "C1", filesDir: "/state", label: "[slack]" },
        { primaryFileIds: ["F1"], buffered: { files: [], skipped: 0 } },
      ),
    );

    expect(events).toEqual([{ type: "failed", details: expect.stringContaining("access_denied"), retryable: true }]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("degrades failed background files individually and tells the model what is missing", async () => {
    let prompt: Prompt | undefined;
    const agent: Agent = {
      async *invoke(_scope, value): AsyncIterable<AgentEvent> {
        prompt = value;
        yield { type: "completed" };
      },
    };
    const api = fakeApi({
      fileInfo: async (id) => {
        if (id === "GONE") throw new Error("deleted");
        return { id, name: "earlier.txt", mimetype: "text/plain" };
      },
    });

    await collect(
      invokeSlackTurn(
        agent,
        "s1",
        "answer",
        { api, channelId: "C1", filesDir: "/state", label: "[slack]" },
        {
          primaryFileIds: [],
          buffered: {
            files: [
              { id: "OK", from: "user U1", messageId: "1.0" },
              { id: "GONE", from: "user U2", messageId: "2.0" },
            ],
            skipped: 1,
          },
        },
      ),
    );

    expect(prompt?.text).toContain("/state/OK.txt");
    expect(prompt?.text).toContain("2 file(s) from the earlier discussion are not loaded");
  });
});
