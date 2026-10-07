import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeishuListedMessage } from "../src/channels/feishu/feishu-api.ts";
import { type FeishuPlaceRead, createFeishuPlaceHistory, feishuHistoryKey } from "../src/channels/feishu/history.ts";
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
    msg_type: "text",
    create_time: String(++clock),
    body: { content: JSON.stringify({ text }) },
    sender: { id: "ou_alice", id_type: "open_id", sender_type: "user" },
    ...over,
  };
}

/** A place whose messages the test appends to (oldest first); the fake lists them newest first, as the platform does. */
function setup(opts: { turnInputs?: string[]; names?: () => Promise<Map<string, string>>; path?: string } = {}) {
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
  const chatMemberNames = vi.fn(opts.names ?? (async () => new Map([["ou_alice", "Alice"]])));
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
  return {
    messages,
    /** A person asks the agent here: the turn's read ends at this message. */
    ask(key = "oc_1"): FeishuPlaceRead {
      const ask = msg(`om_ask_${++asks}`, "@bot ?");
      messages.push(ask);
      return { key, until: { at: Number(ask.create_time), id: ask.message_id as string } };
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

/** Someone asks here, and the turn reads, answers and commits. */
async function answeredTurn(place: ReturnType<typeof setup>, key = "oc_1", history = place.history): Promise<string> {
  const read = place.ask(key);
  const peeked = await history.peek(read);
  history.commit(read, peeked.consumed);
  return peeked.text;
}

describe("Feishu place history", () => {
  it("reads what was said since the last answered turn, and nothing that turn already folded", async () => {
    const place = setup();
    place.messages.push(msg("om_1", "deploy failed"), msg("om_2", "on staging"));
    expect(await answeredTurn(place)).toBe("Alice (msg om_1): deploy failed\nAlice (msg om_2): on staging");

    place.messages.push(msg("om_3", "fixed now"));
    expect(await answeredTurn(place)).toBe("Alice (msg om_3): fixed now");
    expect(await answeredTurn(place)).toBe("");
  });

  it("a turn that fails before its answer leaves the discussion to be read again", async () => {
    const place = setup();
    place.messages.push(msg("om_1", "deploy failed"));
    await place.history.peek(place.ask()); // no commit: the turn failed
    expect(await answeredTurn(place)).toContain("deploy failed");
  });

  it("the cursor survives a restart", async () => {
    const place = setup();
    place.messages.push(msg("om_1", "before"));
    await answeredTurn(place);
    place.messages.push(msg("om_2", "after"));
    expect(await answeredTurn(place, "oc_1", place.open())).toBe("Alice (msg om_2): after");
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
    const firstRead = await place.history.peek(first);
    place.history.commit(first, firstRead.consumed);
    expect(firstRead.text).toBe("Alice (msg om_before): the build is red");

    const secondRead = await place.history.peek(second);
    expect(secondRead.text).toBe("Alice (msg om_after): it was the cache"); // neither ask: each is its own turn
    // The read is bounded where the platform can bound it, too.
    expect(place.listMessages).toHaveBeenLastCalledWith(
      { type: "chat", id: "oc_1" },
      50,
      Math.floor(second.until.at / 1000),
    );
  });

  it("a turn's answer, posted after its read, is left out of the next read — however long the place is quiet", async () => {
    const place = setup();
    const self = { sender: { id: "cli_self", sender_type: "app" } };
    const first = place.ask();
    const read = await place.history.peek(first);
    // The answer lands after the read, through the place's recording client.
    place.messages.push(msg("om_answer1", "first answer", self));
    place.history.recordOutput("oc_1", "om_answer1");
    place.history.commit(first, read.consumed);

    // Other places' traffic does not touch this place's record, and a restart keeps it.
    const reopened = place.open();
    for (let i = 0; i < 1500; i++) reopened.recordOutput(`oc_busy_${i % 3}`, `om_busy_${i}`);
    place.messages.push(msg("om_aside", "days later"));
    expect(await answeredTurn(place, "oc_1", reopened)).toBe("Alice (msg om_aside): days later");

    // Passed by a read, the answer no longer needs remembering.
    const saved = JSON.parse(readFileSync(place.path, "utf8")) as Record<string, { outputs: string[] }>;
    expect(saved.oc_1?.outputs).toEqual([]);
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

  it("a place busier than one page since its last answer says so", async () => {
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
    const read = await place.history.peek(place.ask());
    expect(read.text).toContain("(msg om_card): **3 PRs**");
    expect(read.consumed[0]?.folded.at(-1)?.images).toEqual([{ key: "img_1" }]);
  });

  it("an unreadable history is said in the prompt, and the turn after reads it again", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const place = setup();
    place.messages.push(msg("om_1", "deploy failed"));
    place.failWith(new Error("feishu listMessages failed: 99991672 Access denied"));
    expect(await answeredTurn(place)).toBe(
      "(could not read the recent discussion here: Error: feishu listMessages failed: 99991672 Access denied)",
    );
    expect(warn.mock.calls.join("\n")).toContain("could not read the history of place oc_1");

    place.failWith(undefined);
    expect(await answeredTurn(place)).toContain("deploy failed");
  });

  it("without member names, speakers are shown by id, and that is said once per chat", async () => {
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
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("member names"))).toHaveLength(1);
  });

  it("a thread's room is read without moving the room's own cursor", async () => {
    const place = setup();
    place.messages.push(msg("om_1", "room talk"));
    expect((await place.history.room("oc_1")).text).toContain("room talk");
    expect(await answeredTurn(place)).toContain("room talk");
  });

  it("a cursor file of the wrong shape is reported, and every place reads afresh", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const root = mkdtempSync(join(tmpdir(), "feishu-history-bad-"));
    roots.push(root);
    const path = join(root, "history.json");
    writeFileSync(path, JSON.stringify({ oc_1: "not a cursor" }));
    const place = setup({ path });
    place.messages.push(msg("om_1", "still read"));
    expect(await answeredTurn(place)).toContain("still read");
    expect(warn.mock.calls.join("\n")).toContain("unexpected shape");
    expect(JSON.parse(readFileSync(path, "utf8")).oc_1.cursor.id).toBe("om_ask_1"); // a valid file again
  });
});
