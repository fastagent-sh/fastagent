import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type SlackPlaceRead,
  collectFoldedFiles,
  createSlackPlaceHistory,
  slackHistoryKey,
  slackPlaceOf,
} from "../src/channels/slack/history.ts";
import type { SlackApi, SlackListedMessage } from "../src/channels/slack/slack-api.ts";
import { CONTEXT_READ } from "../src/channels/kit/transport.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let clock = 1_700_000_000;
function msg(text: string, over: Partial<SlackListedMessage> = {}): SlackListedMessage & { ts: string } {
  clock += 1;
  return { type: "message", ts: `${clock}.000100`, user: "U1", text, ...over };
}

const CHANNEL = slackHistoryKey("T1", { channelId: "C1" });

/**
 * A channel C1 whose messages the test appends (oldest first), served as Slack serves them (measured): the newest
 * `limit` before `latest`; the channel newest first, a thread oldest first after its root, which comes whatever the
 * range. An `oldest` makes Slack return the OLDEST `limit` after it instead, so a reader passing one loses messages.
 */
function setup(opts: { turnInputs?: string[] } = {}) {
  const messages: (SlackListedMessage & { ts: string })[] = [];
  const page = (
    candidates: (SlackListedMessage & { ts: string })[],
    range: { oldest?: string; latest?: string; limit: number },
  ) => {
    const inRange = candidates.filter(
      (m) =>
        (range.oldest === undefined || Number(m.ts) > Number(range.oldest)) &&
        (range.latest === undefined || Number(m.ts) < Number(range.latest)),
    );
    const slice = range.oldest !== undefined ? inRange.slice(0, range.limit) : inRange.slice(-range.limit);
    return { slice, hasMore: inRange.length > range.limit };
  };
  const channelHistory = vi.fn<SlackApi["channelHistory"]>(async (_channel, range) => {
    const { slice, hasMore } = page(
      messages.filter((m) => m.thread_ts === undefined || m.thread_ts === m.ts),
      range,
    );
    return { messages: slice.reverse(), hasMore };
  });
  const threadReplies = vi.fn<SlackApi["threadReplies"]>(async (_channel, threadTs, range) => {
    const root = messages.filter((m) => m.ts === threadTs);
    const { slice, hasMore } = page(
      messages.filter((m) => m.thread_ts === threadTs && m.ts !== threadTs),
      range,
    );
    return { messages: [...root, ...slice], hasMore };
  });
  const root = mkdtempSync(join(tmpdir(), "slack-history-"));
  roots.push(root);
  const history = createSlackPlaceHistory({
    api: { channelHistory, threadReplies },
    self: () => ({ userId: "UBOT", botId: "BBOT" }),
    label: "[slack]",
    path: join(root, "history.json"),
    isTurnInput: (_key, ts) => opts.turnInputs?.includes(ts) ?? false,
  });
  return {
    messages,
    channelHistory,
    threadReplies,
    history,
    /** A person asks the agent in `key`: the turn's read ends at this message. */
    ask(key = CHANNEL, over: Partial<SlackListedMessage> = {}): SlackPlaceRead {
      const ask = msg("<@UBOT> ?", over);
      messages.push(ask);
      return { key, until: ask.ts };
    },
  };
}

async function answeredTurn(place: ReturnType<typeof setup>, read: SlackPlaceRead): Promise<string> {
  const peeked = await place.history.peek(read);
  place.history.commit(read, peeked.consumed);
  return peeked.text;
}

describe("Slack place history", () => {
  it("a place key names a channel's top level or a thread, and reads back", () => {
    expect(slackPlaceOf(CHANNEL)).toEqual({ teamId: "T1", channelId: "C1" });
    const thread = slackHistoryKey("T1", { channelId: "C1", threadTs: "1.5" });
    expect(slackPlaceOf(thread)).toEqual({ teamId: "T1", channelId: "C1", threadTs: "1.5" });
  });

  it("reads the channel up to the ask, and the next turn from that ask on", async () => {
    const place = setup();
    const said = msg("deploy failed");
    place.messages.push(said);
    const first = place.ask();
    expect(await answeredTurn(place, first)).toBe(`user U1 (msg ${said.ts}): deploy failed`);
    // A context read: a rate limit costs the turn its discussion, never a wait before the turn starts.
    expect(place.channelHistory).toHaveBeenLastCalledWith("C1", { latest: first.until, limit: 20 }, CONTEXT_READ);

    const later = msg("fixed now");
    place.messages.push(later);
    const second = place.ask();
    expect(await answeredTurn(place, second)).toBe(`user U1 (msg ${later.ts}): fixed now`);
    expect(place.channelHistory).toHaveBeenLastCalledWith("C1", { latest: second.until, limit: 50 }, CONTEXT_READ);
  });

  it("labels the agent's own posts, other bots and people, reads a markdown post as written, and drops the platform's", async () => {
    const place = setup();
    place.messages.push(
      // A Markdown post as Slack stores it (measured): blocks, and a `text` that drops the table.
      msg("*Digest*\n, with interactive elements", {
        user: "UBOT",
        bot_id: "BBOT",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Digest" } },
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_list",
                style: "ordered",
                offset: 2,
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [
                      { type: "text", text: "ship the " },
                      { type: "link", url: "https://x.test/cache", text: "cache fix" },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "table",
            rows: [
              [
                { type: "raw_text", text: "repo" },
                {
                  type: "rich_text",
                  elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "stars" }] }],
                },
              ],
              [
                { type: "raw_text", text: "a/b" },
                { type: "raw_text", text: "17,880" },
              ],
            ],
          },
        ],
      }),
      // A block this does not know: the message is read by its `text`, not shown with a hole in it.
      msg("poll: lunch?", { user: "U2", blocks: [{ type: "poll_widget" }] }),
      msg("build #42 green", { user: undefined, bot_id: "BCI", subtype: "bot_message", username: "ci" }),
      msg("deploy bot says hi", { user: "UDEPLOY", bot_id: "BDEPLOY", bot_profile: { name: "deployer" } }),
      msg("<@U1> has joined the channel", { subtype: "channel_join" }),
      msg("a whisper", { hidden: true }),
      msg("see the log", { files: [{ id: "F1", name: "log.txt" }] }),
    );
    const text = await answeredTurn(place, place.ask());
    expect(text.split("\n")).toEqual([
      expect.stringMatching(/^you \(msg [\d.]+\): Digest 3\. ship the cache fix repo \| stars a\/b \| 17,880$/),
      expect.stringMatching(/^user U2 \(msg [\d.]+\): poll: lunch\?$/),
      expect.stringMatching(/^bot ci \(msg [\d.]+\): build #42 green$/),
      expect.stringMatching(/^bot deployer \(msg [\d.]+\): deploy bot says hi$/),
      expect.stringMatching(/^user U1 \(msg [\d.]+\): see the log \[1 attached file\]$/),
    ]);
  });

  it("reads a message's blocks as separate paragraphs, and its text when a block holds something unknown", async () => {
    const place = setup();
    const section = (text: string) => ({ type: "rich_text_section", elements: [{ type: "text", text }] });
    place.messages.push(
      // As the Slack client stores "see below", a code block and "then run it": no newline between the three.
      msg("see below\n```npm test```\nthen run it", {
        blocks: [
          {
            type: "rich_text",
            elements: [
              section("see below"),
              { type: "rich_text_preformatted", elements: [{ type: "text", text: "npm test" }] },
              section("then run it"),
            ],
          },
        ],
      }),
      // A quote holding an inline element this does not know: the whole message falls back to its text.
      msg("> ask <!subteam^S1> first", {
        blocks: [
          {
            type: "rich_text",
            elements: [{ type: "rich_text_quote", elements: [{ type: "text", text: "ask " }, { type: "team" }] }],
          },
        ],
      }),
    );
    const text = await answeredTurn(place, place.ask());
    expect(text.split("\n")).toEqual([
      expect.stringMatching(/: see below npm test then run it$/),
      expect.stringMatching(/: > ask <!subteam\^S1> first$/),
    ]);
  });

  it("reads what an integration says in legacy attachments, and leaves out a message with nothing to show", async () => {
    const place = setup();
    place.messages.push(
      msg("", {
        user: undefined,
        bot_id: "BGH",
        subtype: "bot_message",
        username: "github",
        attachments: [
          { pretext: "1 new commit", title: "fix the cache", text: "a1b2c3 by dana", fallback: "[repo] 1 new commit" },
        ],
      }),
      msg("", {
        user: undefined,
        bot_id: "BALERT",
        subtype: "bot_message",
        username: "alerts",
        attachments: [{ fallback: "CPU 95% on api-1" }],
      }),
      msg("", { user: "U2" }),
    );
    const text = await answeredTurn(place, place.ask());
    expect(text.split("\n")).toEqual([
      expect.stringMatching(/^bot github \(msg [\d.]+\): 1 new commit fix the cache a1b2c3 by dana$/),
      expect.stringMatching(/^bot alerts \(msg [\d.]+\): CPU 95% on api-1$/),
    ]);
  });

  it("a thread's read is its newest page before the ask, cut at the cursor", async () => {
    const place = setup();
    const root = msg("incident thread");
    place.messages.push(root);
    for (let i = 1; i <= 45; i++) place.messages.push(msg(`reply ${i}`, { thread_ts: root.ts }));
    const key = slackHistoryKey("T1", { channelId: "C1", threadTs: root.ts });

    // A first read: the root (the topic) and the newest replies, and a line for what lies between.
    const first = await answeredTurn(place, place.ask(key, { thread_ts: root.ts }));
    expect(first.split("\n").slice(0, 3)).toEqual([
      "(earlier messages here not shown)",
      `user U1 (msg ${root.ts}): incident thread`,
      expect.stringMatching(/: reply 26$/),
    ]);
    expect(first).toMatch(/: reply 45$/);
    expect(place.threadReplies).toHaveBeenLastCalledWith("C1", root.ts, expect.any(Object), CONTEXT_READ);

    // Past the cursor: the root is not discussion again, and a busy stretch says what it did not reach.
    for (let i = 46; i <= 105; i++) place.messages.push(msg(`reply ${i}`, { thread_ts: root.ts }));
    const busy = await answeredTurn(place, place.ask(key, { thread_ts: root.ts }));
    expect(busy).not.toContain("incident thread");
    expect(busy).toContain("earlier message");
    expect(busy).toMatch(/: reply 105$/);

    place.messages.push(msg("one more", { thread_ts: root.ts }));
    const next = await answeredTurn(place, place.ask(key, { thread_ts: root.ts }));
    expect(next).toMatch(/^user U1 \(msg [\d.]+\): one more$/);
  });

  it("leaves out the asks the channel took and the answers it recorded", async () => {
    const earlierAsk = msg("<@UBOT> summarize");
    const place = setup({ turnInputs: [earlierAsk.ts] });
    const answer = msg("the summary", { user: "UBOT", bot_id: "BBOT" });
    place.history.recordOutput(CHANNEL, answer.ts);
    place.messages.push(earlierAsk, answer, msg("thanks"));
    const text = await answeredTurn(place, place.ask());
    expect(text).toMatch(/^user U1 \(msg [\d.]+\): thanks$/);
  });

  it("folded files ride along, minus the turn's own", () => {
    const from = { kind: "human" as const, label: "user U1" };
    const folded = [
      { id: "1.0", at: 0, from, text: "a", images: [], files: [{ key: "F1" }, { key: "F2" }] },
      { id: "2.0", at: 0, from, text: "b", images: [], files: [{ key: "F2" }] },
    ];
    expect(collectFoldedFiles(folded, new Set(["F1"]))).toEqual({
      files: [{ id: "F2", from: "user U1", messageId: "1.0" }],
      skipped: 0,
    });
  });
});
