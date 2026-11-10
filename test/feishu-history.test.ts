import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeishuApi, FeishuListedMessage } from "../src/channels/feishu/feishu-api.ts";
import { type FeishuPosition, createFeishuPlaceHistory, feishuHistoryKey } from "../src/channels/feishu/history.ts";
import type { PlaceRead } from "../src/channels/kit/place-history.ts";
import { CONTEXT_READ } from "../src/channels/kit/transport.ts";
import { log } from "../src/log.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let clock = 1_700_000_000_000;
function msg(id: string, text: string, over: Partial<FeishuListedMessage> = {}): FeishuListedMessage {
  return {
    message_id: id,
    chat_id: "oc_1",
    msg_type: "text",
    create_time: String(++clock),
    body: { content: JSON.stringify({ text }) },
    sender: { id: "ou_alice", id_type: "open_id", sender_type: "user" },
    ...over,
  };
}

/** A place whose messages the test appends to (oldest first); the fake lists them newest first, as the platform does. */
type MemberNames = FeishuApi["chatMemberNames"];

function setup(opts: { turnInputs?: string[]; names?: MemberNames; path?: string } = {}) {
  const messages: FeishuListedMessage[] = [];
  let fail: Error | undefined;
  const listMessages = vi.fn(
    async (_container: { type: "chat" | "thread"; id: string }, pageSize: number, endTime?: number) => {
      if (fail) throw fail;
      const newestFirst = [...messages]
        .reverse()
        .filter((m) => endTime === undefined || Math.floor(Number(m.create_time) / 1000) <= endTime);
      return { items: newestFirst.slice(0, pageSize), hasMore: newestFirst.length > pageSize };
    },
  );
  const chatMemberNames = vi.fn<MemberNames>(
    opts.names ??
      (async (_chatId, wanted) => ({
        names: new Map([["ou_alice", "Alice"]].filter(([id]) => wanted.has(id as string)) as [string, string][]),
        complete: true,
      })),
  );
  const root = mkdtempSync(join(tmpdir(), "feishu-history-"));
  roots.push(root);
  const path = opts.path ?? join(root, "history.json");
  const open = () =>
    createFeishuPlaceHistory({
      api: { listMessages, chatMemberNames },
      appId: "cli_self",
      label: "[feishu]",
      path,
      isTurnInput: (id) => opts.turnInputs?.includes(id) ?? false,
    });
  let asks = 0;
  /** The ask each place's session was last sent: where its next read starts (the Agent's answer, in the channel). */
  const sent = new Map<string, FeishuPosition>();
  return {
    messages,
    /**
     * A person asks the agent here: the turn's read starts after the ask its session was last sent and ends at this
     * message. An ask that is `lost` never reached the session (it failed before it was sent), so the next read still
     * starts before it.
     */
    ask(key = "oc_1", { lost = false } = {}): PlaceRead<FeishuPosition> & { until: FeishuPosition } {
      const ask = msg(`om_ask_${++asks}`, "@bot ?");
      messages.push(ask);
      const until = { at: Number(ask.create_time), id: ask.message_id as string };
      const after = sent.get(key);
      if (!lost) sent.set(key, until);
      return { key, ...(after === undefined ? {} : { after }), until };
    },
    listMessages,
    chatMemberNames,
    path,
    open,
    history: open(),
    failWith: (error: Error | undefined) => {
      fail = error;
    },
  };
}

/** Someone asks here, and the turn reads and sends its ask. */
async function answeredTurn(place: ReturnType<typeof setup>, key = "oc_1", history = place.history): Promise<string> {
  return (await history.fold(place.ask(key))).text;
}

describe("Feishu place history", () => {
  it("reads what was said since the ask its session was last sent, and nothing that ask already folded", async () => {
    const place = setup();
    place.messages.push(msg("om_1", "deploy failed"), msg("om_2", "on staging"));
    expect(await answeredTurn(place)).toBe("Alice (msg om_1): deploy failed\nAlice (msg om_2): on staging");

    place.messages.push(msg("om_3", "fixed now"));
    expect(await answeredTurn(place)).toBe("Alice (msg om_3): fixed now");
    expect(await answeredTurn(place)).toBe("");
  });

  it("an ask that never reached the session leaves the discussion to be read again", async () => {
    const place = setup();
    place.messages.push(msg("om_1", "deploy failed"));
    await place.history.fold(place.ask("oc_1", { lost: true })); // it failed before it was sent
    expect(await answeredTurn(place)).toContain("deploy failed");
  });

  it("reads the same range the same way again: nothing a read does is remembered", async () => {
    const place = setup();
    place.messages.push(msg("om_1", "deploy failed"));
    const read = place.ask();
    const first = await place.history.fold(read);
    place.messages.push(msg("om_2", "said after"));
    expect((await place.history.fold(read)).text).toBe(first.text); // a replayed turn reads what it read before
  });

  it("leaves out what the session holds — turn asks and turn answers — and keeps the agent's own posts", async () => {
    const place = setup({ turnInputs: ["om_ask"] });
    place.history.recordOutput("oc_1", "om_answer");
    place.messages.push(
      msg("om_ask", "@bot summarize"),
      msg("om_answer", "the summary", { sender: { id: "cli_self", sender_type: "app" } }),
      msg("om_digest", `daily digest ${"x".repeat(3000)}`, { sender: { id: "cli_self", sender_type: "app" } }),
      msg("om_other_bot", "build #42 green", { sender: { id: "cli_ci", sender_type: "app" } }),
      msg("om_sys", "", { msg_type: "system" }),
      msg("om_deleted", "oops", { deleted: true }),
    );
    const text = await answeredTurn(place);
    expect(text).not.toContain("summarize");
    expect(text).not.toContain("the summary");
    expect(text).not.toContain("oops");
    // A digest is the agent's own words: kept past the per-line bound people get, up to its own cap.
    expect(text).toMatch(/^you \(msg om_digest\): daily digest x{1900,}/);
    expect(text).toContain(" … (truncated)");
    expect(text).toContain("bot cli_ci (msg om_other_bot): build #42 green");
    // Only humans need names, and only humans are asked about.
    expect(place.chatMemberNames).toHaveBeenCalledTimes(0);
  });

  it("a turn reads up to its own ask: a queued ask, and what was said after, wait for their own turn", async () => {
    const place = setup(); // no record of which messages were asks: the bound alone keeps them out
    place.messages.push(msg("om_before", "the build is red"));
    const first = place.ask();
    place.messages.push(msg("om_after", "it was the cache"));
    const second = place.ask(); // queued behind the first, in the same session
    const firstRead = await place.history.fold(first);
    expect(firstRead.text).toBe("Alice (msg om_before): the build is red");

    const secondRead = await place.history.fold(second);
    expect(secondRead.text).toBe("Alice (msg om_after): it was the cache"); // neither ask: each is its own turn
    // The read is bounded where the platform can bound it, too.
    expect(place.listMessages).toHaveBeenLastCalledWith(
      { type: "chat", id: "oc_1" },
      50,
      Math.floor(second.until.at / 1000),
      CONTEXT_READ,
    );
  });

  it("a turn's answer, posted after its read, is left out of the next read — however long the place is quiet", async () => {
    const place = setup();
    const self = { sender: { id: "cli_self", sender_type: "app" } };
    await place.history.fold(place.ask());
    // The answer lands after the read, through the place's recording client.
    place.messages.push(msg("om_answer1", "first answer", self));
    place.history.recordOutput("oc_1", "om_answer1");

    // Other places' traffic does not touch this place's record, and a restart keeps it.
    const reopened = place.open();
    for (let i = 0; i < 1500; i++) reopened.recordOutput(`oc_busy_${i % 3}`, `om_busy_${i}`);
    place.messages.push(msg("om_aside", "days later"));
    expect(await answeredTurn(place, "oc_1", reopened)).toBe("Alice (msg om_aside): days later");
    const saved = JSON.parse(readFileSync(place.path, "utf8")) as Record<string, string[]>;
    expect(saved.oc_1).toEqual(["om_answer1"]);
  });

  it("an output that cannot be persisted is still left out, and the failure is said", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const place = setup();
    mkdirSync(`${place.path}.tmp`); // the atomic write's temp path is a directory: every write fails
    place.messages.push(msg("om_answer", "an answer", { sender: { id: "cli_self", sender_type: "app" } }));
    expect(() => place.history.recordOutput("oc_1", "om_answer")).not.toThrow(); // the message was sent
    expect(warn.mock.calls.join("\n")).toContain("may fold the agent's own answer");
    expect(await answeredTurn(place)).toBe("");
  });

  it("a place's first read takes its newest 20 messages, and says there are earlier ones", async () => {
    const place = setup();
    for (let i = 1; i <= 25; i++) place.messages.push(msg(`om_${i}`, `line ${i}`));
    const text = await answeredTurn(place);
    expect(text.split("\n")[0]).toBe("(earlier messages here not shown)");
    expect(text).toContain("(msg om_6)");
    expect(text).not.toContain("(msg om_5)");
  });

  it("a place busier than one page since its session last read says so", async () => {
    const place = setup();
    place.messages.push(msg("om_0", "answered"));
    await answeredTurn(place);
    for (let i = 1; i <= 60; i++) place.messages.push(msg(`om_${i}`, "x"));
    const text = await answeredTurn(place);
    expect(text.split("\n")[0]).toMatch(/earlier message/);
    expect(text).not.toContain("(msg om_10)");
    expect(text).toContain("(msg om_60)");
  });

  it("keeps the newest discussion inside the budget and counts what it left out", async () => {
    const place = setup();
    for (let i = 1; i <= 19; i++) place.messages.push(msg(`om_${i}`, "y".repeat(400)));
    const text = await answeredTurn(place);
    expect(text.length).toBeLessThanOrEqual(4000 + 60);
    expect(text).toContain("(msg om_19)");
    expect(text.split("\n")[0]).toMatch(/^\(\d+ earlier messages here not shown\)$/);
  });

  it("a topic group's room is its topics' first posts: replies inside a topic are that topic's", async () => {
    const place = setup();
    place.messages.push(
      msg("om_topic", "new topic", { thread_id: "omt_1" }),
      msg("om_reply", "reply inside it", { thread_id: "omt_1", root_id: "om_topic", parent_id: "om_topic" }),
      msg("om_quote", "a quote in the room", { parent_id: "om_topic", root_id: "om_topic" }),
    );
    const text = await answeredTurn(place);
    expect(text).toContain("new topic");
    expect(text).not.toContain("reply inside it");
    expect(text).toContain("Alice (msg om_quote, reply to msg om_topic): a quote in the room");

    // The thread itself reads every message in it.
    await answeredTurn(place, feishuHistoryKey({ chatId: "oc_1", threadId: "omt_1" }));
    expect(place.listMessages.mock.lastCall?.slice(0, 2)).toEqual([{ type: "thread", id: "omt_1" }, 50]);
  });

  it("reads a Card 2.0 as it was sent, and carries an image's key for the turn to load", async () => {
    const place = setup();
    place.messages.push(
      msg("om_card", "", {
        msg_type: "interactive",
        body: {
          content: JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "markdown", content: "**3 PRs**" }] } }),
        },
      }),
      msg("om_img", "", { msg_type: "image", body: { content: JSON.stringify({ image_key: "img_1" }) } }),
    );
    const read = await place.history.fold(place.ask());
    expect(read.text).toContain("(msg om_card): **3 PRs**");
    expect(read.folded.at(-1)?.images).toEqual([{ key: "img_1" }]);
  });

  it("an unreadable history is said in the prompt and flagged, so its ask can be forgotten and the next turn reads it again", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const place = setup();
    place.messages.push(msg("om_1", "deploy failed"));
    place.failWith(new Error("feishu listMessages failed: 99991672 Access denied"));
    const failed = await place.history.fold(place.ask("oc_1", { lost: true })); // the channel forgets this ask
    expect(failed.text).toBe(
      "(could not read the recent discussion here: Error: feishu listMessages failed: 99991672 Access denied)",
    );
    expect(failed.unread).toBe(true);
    expect(warn.mock.calls.join("\n")).toContain("could not read the history of place oc_1");

    place.failWith(undefined);
    expect(await answeredTurn(place)).toContain("deploy failed");
  });

  it("without member names, speakers are shown by id; the failure is said and not retried until the names expire", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const place = setup({
      names: async () => {
        throw new Error("99991672 no im:chat.members:read");
      },
    });
    place.messages.push(msg("om_1", "first"));
    expect(await answeredTurn(place)).toBe("user ou_alice (msg om_1): first");
    place.messages.push(msg("om_2", "second"));
    await answeredTurn(place);
    expect(place.chatMemberNames).toHaveBeenCalledTimes(1); // the second turn does not pay for a known failure
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("member names"))).toHaveLength(1);
  });

  it("names only the speakers shown, reuses them, and says when a large chat's names ran out", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const place = setup({
      // A chat larger than one read covers: Alice is found, Bob is past the cap.
      names: async (_chatId, wanted) => ({
        names: new Map([...wanted].filter((id) => id === "ou_alice").map((id) => [id, "Alice"])),
        complete: false,
      }),
    });
    const bob = { sender: { id: "ou_bob", sender_type: "user" } };
    place.messages.push(msg("om_1", "hi"), msg("om_2", "hello", bob));
    expect(await answeredTurn(place)).toBe("Alice (msg om_1): hi\nuser ou_bob (msg om_2): hello");
    expect(place.chatMemberNames.mock.calls[0]?.[1]).toEqual(new Set(["ou_alice", "ou_bob"]));
    expect(place.chatMemberNames.mock.calls[0]?.[2]).toBe(CONTEXT_READ);
    expect(warn.mock.calls.join("\n")).toContain("1 speaker(s) are shown by open_id");

    // Both are known now (one by name, one as unnameable): the next turn reads no names.
    place.messages.push(msg("om_3", "again"), msg("om_4", "me too", bob));
    await answeredTurn(place);
    expect(place.chatMemberNames).toHaveBeenCalledTimes(1);
  });

  it("a thread's room is read from where the room's own session read to", async () => {
    const place = setup();
    place.messages.push(msg("om_1", "room talk"));
    const asked = place.ask(); // the room's session was last sent this ask
    place.messages.push(msg("om_2", "said since"));
    const room = await place.history.fold({ key: "oc_1", after: asked.until });
    expect(room.text).toBe("Alice (msg om_2): said since");
    expect((await place.history.fold({ key: "oc_1" })).text).toContain("room talk"); // a room nothing was asked in
  });

  it("an outputs file of the wrong shape is reported, and every place reads afresh", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const root = mkdtempSync(join(tmpdir(), "feishu-history-bad-"));
    roots.push(root);
    const path = join(root, "history.json");
    writeFileSync(path, JSON.stringify({ oc_1: "not a list of ids" }));
    const place = setup({ path });
    place.messages.push(msg("om_1", "still read"));
    expect(await answeredTurn(place)).toContain("still read");
    expect(warn.mock.calls.join("\n")).toContain("unexpected shape");
  });

  it("a thread named for another chat is refused, never read into this one", async () => {
    const place = setup();
    place.messages.push(msg("om_secret", "the other group's plan", { chat_id: "oc_2", thread_id: "omt_9" }));
    const key = feishuHistoryKey({ chatId: "oc_1", threadId: "omt_9" });
    await expect(place.history.snapshot(key)).rejects.toThrow("thread omt_9 is not in chat oc_1");
    const folded = await place.history.fold({ key, until: { at: Date.now(), id: "om_ask" } });
    expect(folded.text).toContain("could not read the recent discussion here");
    expect(folded.text).not.toContain("plan");
  });

  it("lists the chat's threads newest first, each by its earliest message seen, and reads one whole", async () => {
    const place = setup();
    place.messages.push(
      msg("om_t1", "deploy failed on staging", { thread_id: "omt_1" }),
      msg("om_t2", "lunch plans", { thread_id: "omt_2", sender: { id: "ou_bob", sender_type: "user" } }),
      msg("om_t1_reply", "killed the backfill, redeploy succeeded", { thread_id: "omt_1", root_id: "om_t1" }),
      msg("om_plain", "no thread here"),
      // A topic group lists the platform's own messages with a thread of their own.
      msg("om_sys", "", { thread_id: "omt_3", msg_type: "system", sender: {} }),
    );
    const list = await place.history.threads("oc_1");
    expect(list.split("\n")).toEqual([
      expect.stringContaining(
        "Threads in this room, newest first by the time shown (among this chat's newest 50 messages)",
      ),
      "A thread shown by when it started may have later replies this list cannot see: read it.",
      // A reply seen in the listing (a topic group) is the thread's last activity; a root alone is only its start.
      expect.stringMatching(
        /^- thread omt_1 \(last active \d{4}-\d\d-\d\d \d\d:\d\d UTC\): Alice: deploy failed on staging$/,
      ),
      expect.stringMatching(/^- thread omt_2 \(started .+\): user ou_bob: lunch plans$/),
    ]);
    // A tool's read leaves nothing out: what the session holds elsewhere is what this thread said.
    place.history.recordOutput(feishuHistoryKey({ chatId: "oc_1", threadId: "omt_1" }), "om_t1_reply");
    const read = await place.history.snapshot(feishuHistoryKey({ chatId: "oc_1", threadId: "omt_1" }));
    expect(read.text).toContain("killed the backfill, redeploy succeeded");
  });
});
