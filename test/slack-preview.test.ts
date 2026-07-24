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

describe("native Slack tool traces", () => {
  it("shows the invoked operation and a bounded failed result as inline Markdown", async () => {
    const api = fakeApi();
    const events = (async function* (): AsyncIterable<AgentEvent> {
      yield {
        type: "tool_started",
        id: "tool-1",
        name: "bash",
        args: { command: `npm test <!channel> ${"🐍".repeat(80)}` },
      };
      yield {
        type: "tool_ended",
        id: "tool-1",
        isError: true,
        content: {
          content: [{ type: "text", text: `permission denied <!here> ${"💥".repeat(300)}` }],
        },
      };
      yield { type: "text", delta: "Recovered." };
      yield { type: "completed" };
    })();

    await streamSlackReply(events, api, { channelId: "D1", threadTs: "1.0" }, () => "failed", {
      rendering: "native",
      disclaimer: false,
    });

    const invocation = vi.mocked(api.startStream).mock.calls[0]?.[1]?.markdownText ?? "";
    expect(invocation).toContain("**Bash** — `npm test &lt;!channel>");
    expect(invocation).not.toContain("<!channel>");

    const appended = vi.mocked(api.appendStream).mock.calls.map(([, , content]) => content.markdownText ?? "");
    const failure = appended.find((text) => text.includes("failed")) ?? "";
    expect(failure).toContain("**Bash** failed — `permission denied &lt;!here>");
    expect(failure).not.toContain("<!here>");
    expect(failure).toContain("…");
    expect(Array.from(failure).length).toBeLessThanOrEqual(300);
    expect(appended.join("\n")).toContain("Recovered.");
  });
});

describe("native DM Agent status around a retry backoff", () => {
  function eventSource() {
    const queue: AgentEvent[] = [];
    let notify: (() => void) | undefined;
    let done = false;
    return {
      push(e: AgentEvent) {
        queue.push(e);
        notify?.();
      },
      end() {
        done = true;
        notify?.();
      },
      iterable: (async function* (): AsyncIterable<AgentEvent> {
        while (true) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => (notify = resolve));
        }
      })(),
    };
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("serializes status writes so a slow retry status cannot land after its restore", async () => {
    const api = fakeApi();
    const gates: Array<() => void> = [];
    vi.mocked(api.setThreadStatus).mockImplementation(() => new Promise<void>((resolve) => gates.push(resolve)));
    const statuses = () => vi.mocked(api.setThreadStatus).mock.calls.map((c) => c[1]);

    const src = eventSource();
    const turn = streamSlackReply(src.iterable, api, { channelId: "D1", threadTs: "1.0" }, () => undefined, {
      rendering: "native",
      disclaimer: false,
    });
    await flush();
    gates.shift()?.(); // initial "is working…" status (awaited before the loop)
    await flush();

    src.push({ type: "text", delta: "a" });
    src.push({ type: "retrying", attempt: 1, maxAttempts: 4, delayMs: 2_000, reason: "503" });
    await flush();
    expect(statuses().at(-1)).toContain("retrying");

    // Progress while the retry-status write is still in flight: the restore must QUEUE behind it,
    // not race it — otherwise the stale "retrying" line could land last.
    src.push({ type: "text", delta: "b" });
    await flush();
    expect(statuses()).toHaveLength(2);
    gates.shift()?.(); // retry status delivered
    await flush();
    expect(statuses()).toHaveLength(3);
    expect(statuses().at(-1)).toBe("is working on your request…");

    src.push({ type: "completed" });
    src.end();
    gates.shift()?.(); // restore delivered
    await flush();
    gates.shift()?.(); // final clear delivered
    await turn;
    expect(statuses().at(-1)).toBe(""); // the clear is last, after every queued write
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
    // Many `<` start positions with no closing `>`: this is the case a `>`-only bound handles in O(n^2).
    const manyStarts = "<!".repeat(200_000);
    const start = Date.now();
    // Nothing matches (no closing '>'), so each input is returned unchanged — the point is that this
    // completes fast instead of triggering polynomial backtracking.
    expect(sanitizeSlackMarkdown(unterminatedBang)).toBe(unterminatedBang);
    expect(sanitizeSlackMarkdown(unterminatedPipes)).toBe(unterminatedPipes);
    expect(sanitizeSlackMarkdown(manyStarts)).toBe(manyStarts);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
