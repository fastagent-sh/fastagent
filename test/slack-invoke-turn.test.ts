import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import type { SendRequest } from "../src/agent-api.ts";
import { promptOf, scriptedAgent } from "./scripted-agent.ts";
import { scriptedRun } from "./scripted-run.ts";
import { slackTurnStream } from "../src/channels/slack/invoke-turn.ts";
import { run } from "./channel-effects.ts";
import { type SlackApi, SlackApiError } from "../src/channels/slack/slack-api.ts";

function fakeApi(overrides: Partial<SlackApi> = {}): SlackApi {
  return {
    recordingSends(this: SlackApi) {
      return this;
    },
    channelHistory: async () => ({ messages: [], hasMore: false }),
    userName: async () => undefined,
    threadReplies: async () => ({ messages: [], hasMore: false }),
    authTest: async () => ({}),
    postMessage: async () => "1.0",
    postMarkdown: async () => "1.0",
    updateMessage: async () => {},
    updateMarkdown: async () => {},
    deleteMessage: async () => {},
    sendMarkdown: async () => ({ ts: "1.0", channelId: "C1" }),
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
    uploadFile: async () => ({ id: "F1", name: "x" }),
    ...overrides,
  };
}

const textOf = (content: SendRequest["content"] | undefined) =>
  content === undefined ? undefined : promptOf({ content }).text;
const imagesOf = (content: SendRequest["content"] | undefined) =>
  content === undefined ? undefined : (promptOf({ content }).images ?? []);

describe("Slack turn attachment resolution", () => {
  it.each([false, true])("cancellation joins input loading without starting the model (reject=%s)", async (reject) => {
    const entered = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<void>();
    const abort = new AbortController();
    const agent = scriptedAgent((request) => scriptedRun(request));
    const api = fakeApi({
      fileInfo: async (id) => {
        entered.resolve();
        await loaded.promise;
        return { id, mimetype: "text/plain", name: "file.txt" };
      },
    });
    let released = false;
    const done = Effect.runPromiseExit(
      Stream.runDrain(
        slackTurnStream(
          agent,
          { session: async () => "s", key: "k", text: "read it" },
          { api, channelId: "C1", filesDir: "/state", label: "[slack]" },
          { primaryFileIds: ["F1"], buffered: { files: [], skipped: 0 } },
        ),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            released = true;
          }),
        ),
      ),
      { signal: abort.signal },
    );
    await entered.promise;
    abort.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(released).toBe(false);
    expect(agent.sent).toEqual([]);
    if (reject) loaded.reject(new Error("late attachment failure"));
    else loaded.resolve();
    const exit = await done;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(released).toBe(true);
    expect(agent.sent).toEqual([]);
  });
  it("turns primary images into vision input and ordinary files into an absolute-path manifest", async () => {
    const agent = scriptedAgent((request) => scriptedRun(request));
    const api = fakeApi({
      fileInfo: async (id) => ({ id, name: `${id}.dat`, mimetype: id === "IMG" ? "image/png" : "text/plain" }),
    });
    const events = await run(
      Stream.runCollect(
        slackTurnStream(
          agent,
          { session: async () => "s1", key: "k", text: "read these" },
          { api, channelId: "C1", filesDir: "/state", label: "[slack]" },
          { primaryFileIds: ["IMG", "DOC"], buffered: { files: [], skipped: 0 } },
        ),
      ),
    );

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(imagesOf(agent.sent[0]?.content)).toEqual([{ mimeType: "image/png", data: "aW1n" }]);
    expect(textOf(agent.sent[0]?.content)).toContain("/state/DOC.txt");
  });

  it("turns a primary file failure into a refusal without invoking the Agent", async () => {
    const agent = scriptedAgent((request) => scriptedRun(request));
    const api = fakeApi({ fileInfo: async () => Promise.reject(new Error("access_denied")) });

    const events = await run(
      Stream.runCollect(
        slackTurnStream(
          agent,
          { session: async () => "s1", key: "k", text: "read it" },
          { api, channelId: "C1", filesDir: "/state", label: "[slack]" },
          { primaryFileIds: ["F1"], buffered: { files: [], skipped: 0 } },
        ),
      ),
    );

    // not retryable: the same attachment fails the same way next time, so "try again" is the wrong advice
    expect(events).toMatchObject([
      { type: "rejected", error: { message: expect.stringContaining("access_denied"), retryable: false } },
    ]);
    expect(agent.sent).toEqual([]);
  });

  it.each([
    ["a network error", 0],
    ["exhausted rate-limit retries", 429],
    ["a Slack outage", 503],
  ])("reports %s as retryable, since the same send can succeed later", async (_label, status) => {
    const api = fakeApi({
      fileInfo: async () => Promise.reject(new SlackApiError("files.info", status, "boom")),
    });

    const events = await run(
      Stream.runCollect(
        slackTurnStream(
          scriptedAgent((request) => scriptedRun(request)),
          { session: async () => "s1", key: "k", text: "read it" },
          { api, channelId: "C1", filesDir: "/state", label: "[slack]" },
          { primaryFileIds: ["F1"], buffered: { files: [], skipped: 0 } },
        ),
      ),
    );

    expect(events).toMatchObject([
      { type: "rejected", error: { message: expect.stringContaining("boom"), retryable: true } },
    ]);
  });

  it("degrades failed background files individually and tells the model what is missing", async () => {
    const agent = scriptedAgent((request) => scriptedRun(request));
    const api = fakeApi({
      fileInfo: async (id) => {
        if (id === "GONE") throw new Error("deleted");
        return { id, name: "earlier.txt", mimetype: "text/plain" };
      },
    });

    await run(
      Stream.runDrain(
        slackTurnStream(
          agent,
          { session: async () => "s1", key: "k", text: "answer" },
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
      ),
    );

    expect(textOf(agent.sent[0]?.content)).toContain("/state/OK.txt");
    expect(textOf(agent.sent[0]?.content)).toContain("2 attachment(s) from the earlier discussion are not loaded");
  });
});
