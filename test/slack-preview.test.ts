import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { sanitizeSlackMarkdown, streamSlackReply } from "../src/channels/slack/preview.ts";
import { type SlackApi, SlackApiError } from "../src/channels/slack/slack-api.ts";

function fakeApi(): SlackApi {
  return {
    authTest: vi.fn(async () => ({})),
    postMessage: vi.fn(async () => "1.0"),
    postMarkdown: vi.fn(async () => "1.0"),
    updateMessage: vi.fn(async () => {}),
    updateMarkdown: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    sendMarkdown: vi.fn(async () => "1.0"),
    startStream: vi.fn(async () => "1.0"),
    appendStream: vi.fn(async () => {}),
    stopStream: vi.fn(async () => {}),
    setThreadStatus: vi.fn(async () => {}),
    setThreadTitle: vi.fn(async () => {}),
    addReaction: vi.fn(async () => {}),
    removeReaction: vi.fn(async () => {}),
    fileInfo: vi.fn(async (id) => ({ id })),
    fetchImage: vi.fn(async () => ({ mimeType: "image/png", data: "aW1n" })),
    fetchFile: vi.fn(async (file) => ({ path: `/tmp/${file.id}`, name: String(file.id), size: 1 })),
  };
}

async function* quickClassicTurn(): AsyncIterable<AgentEvent> {
  yield { type: "thinking", delta: "private reasoning" };
  yield { type: "text", delta: "**answer**" };
  yield { type: "completed" };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Slack reply rendering", () => {
  it("falls back visibly to one compatibility reply when a native stream cannot start", async () => {
    const api = fakeApi();
    vi.mocked(api.startStream).mockRejectedValueOnce(
      new SlackApiError("chat.startStream", 403, "missing_scope", "missing_scope"),
    );
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    await streamSlackReply(quickClassicTurn(), api, { channelId: "D1", threadTs: "1.0" }, () => "failed", {
      rendering: "native",
      disclaimer: false,
    });

    expect(api.sendMarkdown).toHaveBeenCalledWith({ channelId: "D1", threadTs: "1.0" }, "**answer**");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("native Slack stream was unavailable"));
  });

  it("does not duplicate an ambiguously-created native stream with a compatibility reply", async () => {
    const api = fakeApi();
    vi.mocked(api.startStream).mockRejectedValueOnce(
      new SlackApiError("chat.startStream", 0, "connection reset after request"),
    );

    await expect(
      streamSlackReply(quickClassicTurn(), api, { channelId: "D1", threadTs: "1.0" }, () => "failed", {
        rendering: "native",
        disclaimer: false,
      }),
    ).rejects.toThrow(/connection reset/);
    expect(api.sendMarkdown).not.toHaveBeenCalled();
  });

  it("enforces Slack's three-second chat.update interval across a completed pump", async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const pending = streamSlackReply(quickClassicTurn(), api, { channelId: "D1", threadTs: "1.0" }, () => "failed", {
      rendering: "classic",
      disclaimer: false,
    });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(api.postMarkdown).toHaveBeenCalledWith({ channelId: "D1", threadTs: "1.0" }, "💭 Thinking…");
    expect(api.updateMarkdown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(api.updateMarkdown).toHaveBeenCalledWith("D1", "1.0", "**answer**");
    expect(JSON.stringify(vi.mocked(api.postMarkdown).mock.calls)).not.toContain("private reasoning");
  });
});

describe("sanitizeSlackMarkdown", () => {
  it("neutralizes Slack control mentions and preserves ordinary autolinks", () => {
    expect(sanitizeSlackMarkdown("ping <!channel> now")).toBe("ping &lt;!channel> now");
    expect(sanitizeSlackMarkdown("hi <@U123>")).toBe("hi &lt;@U123>");
    expect(sanitizeSlackMarkdown("<@U1|Bob> and <!subteam^S1|team>")).toBe("&lt;@U1|Bob> and &lt;!subteam^S1|team>");
    expect(sanitizeSlackMarkdown("see <https://example.com>")).toBe("see <https://example.com>");
  });

  it("stays linear on adversarial input (ReDoS regression)", () => {
    const unterminatedBang = `<!${"!".repeat(200_000)}`;
    const unterminatedPipes = `<@0|${"!|".repeat(200_000)}`;
    const start = Date.now();
    // No closing '>', so nothing matches and the input is returned unchanged — the point is that this
    // completes fast instead of triggering polynomial backtracking.
    expect(sanitizeSlackMarkdown(unterminatedBang)).toBe(unterminatedBang);
    expect(sanitizeSlackMarkdown(unterminatedPipes)).toBe(unterminatedPipes);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
