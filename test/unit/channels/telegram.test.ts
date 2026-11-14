import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { channelContext } from "../../../src/channels/context.ts";
import {
  type TelegramChannelOptions,
  type TelegramUpdate,
  defaultTelegramRoute,
  telegramChannel as buildTelegramChannel,
} from "../../../src/telegram.ts";
import { type Agent, type ErrorCode, agentError } from "../../../src/agent-api.ts";
import { promptOf, scriptedAgent, stoppedRun, withStop } from "../../doubles/scripted-agent.ts";
import { ev } from "../../doubles/scripted-run.ts";
import {
  createChannelSandbox,
  flushFetchMock,
  replyingAgent as baseReplyingAgent,
} from "../../harnesses/channel-harness.ts";

const sandbox = createChannelSandbox("tg-state-");
const flush = flushFetchMock;
const replyingAgent = (reply = "") => {
  const { agent, prompts } = baseReplyingAgent(reply);
  return { agent, calls: prompts };
};

const SECRET = "tg-secret";
const API = "http://tg.test";
const act = () => ({}); // route: always answer, all defaults

function tgRequest(update: unknown, opts: { secret?: string } = {}): Request {
  return new Request("http://app/telegram", {
    method: "POST",
    body: JSON.stringify(update),
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": opts.secret ?? SECRET },
  });
}

const MSG: TelegramUpdate = { update_id: 5, message: { message_id: 1, text: "hi", chat: { id: 42, type: "private" } } };
const callsTo = (m: ReturnType<typeof vi.fn>, method: string) =>
  m.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`)) as [string, RequestInit][];
const bodyOf = (call: [string, RequestInit] | undefined) => {
  if (!call) throw new Error("expected a matching fetch call");
  return JSON.parse(String(call[1].body));
};

/** Bot API fetch mock: sendMessage returns a message_id (so the channel edits its ONE preview message),
 *  getMe returns a username, everything else is ok. */
function okFetch() {
  let id = 100;
  return vi.fn(async (url: string) => {
    const method = String(url).split("/").pop();
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { username: "mybot" } }), { status: 200 });
    const result = method === "sendMessage" ? { message_id: id++ } : {};
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  });
}

afterEach(sandbox.drainAndClean);

/** A fresh throwaway CHANNEL HOME (`<temp root>/channels/telegram`, what the channel derives from
 *  ctx.stateRoot; the temp root is cleaned up in afterEach). Assertions read files at the home. */
const rootOfHome = new Map<string, string>();
const freshStateDir = (): string => {
  const root = sandbox.freshRoot();
  const home = join(root, "channels", "telegram");
  mkdirSync(home, { recursive: true }); // tests may seed files at the home before the channel boots
  rootOfHome.set(home, root);
  return home;
};

/** The old two-arg shape over the ChannelModule contract, returning the mounted handler directly —
 *  keeps every call site terse. The test-only `stateDir` field is the channel HOME from
 *  {@link freshStateDir} (mapped back to its root for ctx), so persistence tests share one home across
 *  "restarts" and read files at the same paths. */
const telegramChannel = (
  agent: Agent,
  {
    stateDir,
    stopped,
    ...opts
  }: TelegramChannelOptions & { stateDir?: string; stopped?: (session: string) => { stopped: string[] } },
) => {
  const home = stateDir ?? freshStateDir();
  const root = rootOfHome.get(home);
  if (!root) throw new Error("test stateDir must come from freshStateDir()");
  const handler = buildTelegramChannel(opts)(
    channelContext(stopped ? withStop(agent, stopped) : agent, root, "telegram"),
  )["POST /telegram"]!;
  // Register the turn-queue idle so drainAndClean() awaits this channel's fire-and-forget turns deterministically.
  sandbox.trackIdle(handler);
  return handler;
};

describe("defaultTelegramRoute + telegramEnvelope", () => {
  it("answers a private message; a group only on a mention ENTITY naming the bot or reply-to-bot, not a slash command", () => {
    expect(defaultTelegramRoute(MSG)).toEqual({}); // private → act
    const group = { id: -100, type: "supergroup" };
    const g = (text: string) => ({ update_id: 1, message: { message_id: 2, text, chat: group } });
    // A message whose text carries a server-parsed `mention` entity — the shape Telegram actually sends.
    const gm = (text: string, mention: string) => ({
      update_id: 1,
      message: {
        message_id: 2,
        text,
        entities: [{ type: "mention", offset: text.indexOf(mention), length: mention.length }],
        chat: group,
      },
    });
    expect(defaultTelegramRoute(g("chatter"))).toBeNull();
    // a group slash command does not summon — bare, or directed (its entity is bot_command, not mention)
    expect(defaultTelegramRoute(g("/ask"))).toBeNull();
    const directed = {
      update_id: 1,
      message: {
        message_id: 2,
        text: "/ask@mybot",
        entities: [{ type: "bot_command", offset: 0, length: 10 }],
        chat: group,
      },
    };
    expect(defaultTelegramRoute(directed, { botUsername: "mybot" })).toBeNull();
    const mention = gm("hey @mybot", "@mybot");
    expect(defaultTelegramRoute(mention)).toBeNull(); // no username → no @mention summon
    expect(defaultTelegramRoute(mention, { botUsername: "mybot" })).toEqual({});
    expect(defaultTelegramRoute(mention, { botUsername: "@mybot" })).toEqual({}); // a leading @ in the option is tolerated
    expect(defaultTelegramRoute(gm("yo @MyBot", "@MyBot"), { botUsername: "mybot" })).toEqual({}); // case-insensitive
    // the entity's exact range is compared — a mention of a DIFFERENT user whose name merely starts
    // with ours does not summon (the substring/boundary confusion class, gone by construction)
    expect(defaultTelegramRoute(gm("@mybottington rocks", "@mybottington"), { botUsername: "mybot" })).toBeNull();
    // raw text containing @mybot WITHOUT a mention entity does not summon — Telegram emits no mention
    // entity for a name inside a code block or a URL, so pasted code/links cannot false-summon
    expect(defaultTelegramRoute(g("see @mybot in that snippet"), { botUsername: "mybot" })).toBeNull();
    // a reply to THIS bot summons (no @mention needed); a reply to ANOTHER bot must not
    const reply = (username?: string) => ({
      update_id: 1,
      message: {
        message_id: 2,
        text: "thanks",
        chat: group,
        reply_to_message: { message_id: 1, chat: group, from: { id: 9, is_bot: true, username } },
      },
    });
    expect(defaultTelegramRoute(reply("MyBot"), { botUsername: "mybot" })).toEqual({}); // ours (case-insensitive)
    expect(defaultTelegramRoute(reply("otherbot"), { botUsername: "mybot" })).toBeNull(); // another bot — stay silent
    // the numeric id is the authoritative identity tier: it wins over username in BOTH directions
    expect(defaultTelegramRoute(reply("otherbot"), { botId: 9 })).toEqual({}); // id matches → ours
    expect(defaultTelegramRoute(reply("MyBot"), { botId: 42, botUsername: "mybot" })).toBeNull(); // id ≠ → silent
    // neither id nor username known (a bare route call) → fail CLOSED: "is this a reply to me?" cannot
    // be yes when the caller supplied no identity — otherwise every multi-bot group mis-summons
    expect(defaultTelegramRoute(reply("otherbot"))).toBeNull();
    // a reply to a HUMAN never summons
    const replyToHuman = reply(undefined);
    replyToHuman.message.reply_to_message.from.is_bot = false;
    expect(defaultTelegramRoute(replyToHuman, { botUsername: "mybot" })).toBeNull();
  });
});

describe("telegram channel", () => {
  it("rejects a missing/wrong secret token with 401 and never routes", async () => {
    vi.stubGlobal("fetch", okFetch()); // the channel asks getMe as it is built
    const { agent } = replyingAgent();
    let routed = false;
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "B",
      route: () => {
        routed = true;
        return null;
      },
    });
    expect((await ch(tgRequest(MSG, { secret: "wrong" }))).status).toBe(401);
    expect((await ch(new Request("http://app/telegram", { method: "POST", body: "{}" }))).status).toBe(401);
    expect(routed).toBe(false);
  });

  it("answers a routed update: composes the prompt (envelope) and sends the reply (model A)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("hello back");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });

    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/\[telegram: chat 42/); // channel composed the envelope
    expect(calls[0]?.text).toMatch(/\bhi\b/); // …around the user's text
    const sent = callsTo(fetchMock, "sendMessage");
    expect(sent).toHaveLength(1); // ONE preview message, edited in place (no per-step spam)
    expect(bodyOf(sent[0])).toMatchObject({ chat_id: 42, text: "💭 Thinking…" }); // a plain placeholder
    const edits = callsTo(fetchMock, "editMessageText");
    expect(edits.length).toBeGreaterThan(0); // streamed live by editing the message
    expect(bodyOf(edits.at(-1))).toMatchObject({ text: "hello back", parse_mode: "HTML" }); // final = the HTML answer
  });

  const groupSettle = async (): Promise<void> => {
    for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r));
  };
  const onlyCommands = (u: TelegramUpdate) => (u.message?.text?.startsWith("/") ? {} : null);
  const grp = { id: -100, type: "supergroup" as const };
  /** A person keeps one id, as on Telegram: the same user is the same sender, and so the same session. */
  const userId = (user: string): number => [...user].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) % 100000;
  const groupMsg = (n: number, user: string, t: string) => ({
    update_id: n,
    message: { message_id: n, text: t, chat: grp, from: { id: userId(user), username: user } },
  });

  it("buffers un-summoned group messages and folds them into a sender's next summoned turn, once per sender", async () => {
    const { agent, calls } = replyingAgent("ok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })),
    );
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", apiBaseUrl: API, route: onlyCommands });

    await ch(tgRequest(groupMsg(1, "alice", "the deploy failed"))); // un-summoned → buffered
    await ch(tgRequest(groupMsg(2, "bob", "which service?"))); // un-summoned → buffered
    await ch(tgRequest(groupMsg(3, "alice", "/bot summarize"))); // summoned → folds the buffer in
    await groupSettle();
    const p1 = calls[0]?.text ?? "";
    expect(p1).toMatch(/recent discussion here/);
    expect(p1).toMatch(/@alice \(msg \d+\): the deploy failed/);
    expect(p1).toMatch(/@bob \(msg \d+\): which service\?/);

    await ch(tgRequest(groupMsg(4, "alice", "/bot again"))); // alice's session holds the discussion already
    await groupSettle();
    expect(calls[1]?.text ?? "").not.toMatch(/recent discussion here/);

    // Bob is another sender with a session of his own: he has read none of it, and is told what was said — the
    // other people's lines and what the agent answered alice, attributed.
    await ch(tgRequest(groupMsg(5, "bob", "/bot and me?")));
    await groupSettle();
    const p3 = calls[2]?.text ?? "";
    expect(p3).toMatch(/@alice \(msg \d+\): the deploy failed/);
    expect(p3).toMatch(/you \(sent by the agent\) \(msg \d+\): ok/);
  });
});

describe("telegram /stop command", () => {
  const okFetch = () =>
    vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 }));
  /** What `abort` answers: a run it stopped, nothing running, or a refusal. */
  const fakeStop = (result: "stopped" | "idle" | ErrorCode) => {
    const aborted: string[] = [];
    const stopped = (session: string): { stopped: string[] } => {
      aborted.push(session);
      if (result === "stopped") return stoppedRun;
      if (result === "idle") return { stopped: [] };
      throw agentError(result, "no run");
    };
    return { stopped, aborted };
  };
  const stopUpdate = (text: string): TelegramUpdate => ({
    update_id: 77,
    message: { message_id: 3, text, chat: { id: 42, type: "private" } },
  });
  const invoked: string[] = [];
  const agent = scriptedAgent(async function* (request) {
    yield ev.message();
    invoked.push(promptOf(request).text);
    yield ev.ended();
  });
  /** A channel home where each conversation already talks in the session named for it. */
  const homeWith = (sessions: Record<string, string>) => {
    const stateDir = freshStateDir();
    writeFileSync(join(stateDir, "sessions.json"), JSON.stringify(sessions));
    return stateDir;
  };

  it("/stop aborts the session, replies, and never becomes a turn", async () => {
    invoked.length = 0;
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { stopped, aborted } = fakeStop("stopped");
    const stateDir = homeWith({ "42": "session-42" });
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", stopped, stateDir });
    expect((await ch(tgRequest(stopUpdate("/stop")))).status).toBe(200);
    await flush(); // the abort runs after the acknowledgement: it waits for what it stops
    expect(aborted).toEqual(["session-42"]);
    expect(invoked).toEqual([]);
    const sent = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(
      ([, init]) => JSON.parse(String(init.body)) as { text?: string },
    );
    expect(sent.some((b) => b.text === "⏹ Stopped.")).toBe(true);
  });

  it("turnsIdle waits for /stop side-task feedback delivery", async () => {
    let releaseReply!: () => void;
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    let replyEntered = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "testbot" } }), { status: 200 });
        }
        replyEntered = true;
        await replyGate;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
      }),
    );
    const { stopped } = fakeStop("stopped");
    const stateDir = homeWith({ "42": "session-42" });
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", stopped, stateDir });
    expect((await ch(tgRequest(stopUpdate("/stop")))).status).toBe(200);
    await flush();
    expect(replyEntered).toBe(true);
    let settled = false;
    const idle = (ch as typeof ch & { turnsIdle: () => Promise<void> }).turnsIdle().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    releaseReply();
    await idle;
    expect(settled).toBe(true);
  });
});
