import { createHmac } from "node:crypto";
import { type Asked, asked, promptOf, scriptedAgent, stoppedRun, withStop } from "./scripted-agent.ts";
import { ev } from "./scripted-run.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelContext } from "../src/channels/context.ts";
import { type Agent, type ErrorCode, agentError } from "../src/agent-api.ts";
import {
  type SlackChannelOptions,
  type SlackEventEnvelope,
  slackChannel,
  slackSocketChannel,
  verifySlackSignature,
} from "../src/slack.ts";
import type { OpenSlackSocket, SlackSocketHandlers } from "../src/channels/slack/socket.ts";

const SECRET = "slack-signing-secret";
const API = "https://slack.test/api";
const roots: string[] = [];
const idles = new Set<() => Promise<void>>();

/**
 * What Slack holds: every message a signed request delivers, and every message the bot posts. `conversations.history`
 * and `conversations.replies` read it, so a turn's place history is what the test said there.
 */
interface PlatformMessage {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
}
const platform: PlatformMessage[] = [];

/** The newest `limit` before `latest` (or, given `oldest`, the oldest `limit` after it), as Slack pages. */
function platformPage(messages: PlatformMessage[], url: URL): { slice: PlatformMessage[]; hasMore: boolean } {
  const param = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;
  const oldest = param("oldest");
  const latest = param("latest");
  const limit = Number(param("limit"));
  const inRange = messages
    .filter(
      (m) =>
        (oldest === undefined || Number(m.ts) > Number(oldest)) &&
        (latest === undefined || Number(m.ts) < Number(latest)),
    )
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  return {
    slice: oldest !== undefined ? inRange.slice(0, limit) : inRange.slice(-limit),
    hasMore: inRange.length > limit,
  };
}

function platformRead(url: URL): Response {
  const channel = url.searchParams.get("channel");
  if (url.pathname.endsWith("/conversations.history")) {
    const { slice, hasMore } = platformPage(
      platform.filter((m) => m.channel === channel && (m.thread_ts === undefined || m.thread_ts === m.ts)),
      url,
    );
    return Response.json({ ok: true, messages: slice.reverse(), has_more: hasMore });
  }
  const root = url.searchParams.get("ts");
  const { slice, hasMore } = platformPage(
    platform.filter((m) => m.channel === channel && m.thread_ts === root && m.ts !== root),
    url,
  );
  // Slack lists the root whatever the range.
  const parent = platform.filter((m) => m.channel === channel && m.ts === root);
  return Response.json({ ok: true, messages: [...parent, ...slice], has_more: hasMore });
}

function replyingAgent(reply = "done") {
  const calls: Asked[] = [];
  const agent = scriptedAgent(async function* (request) {
    yield ev.message();
    calls.push(asked(request));
    if (reply) yield ev.text(reply);
    yield ev.ended();
  });
  return { agent, calls };
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "fa-slack-"));
  roots.push(value);
  return value;
}

function okFetch() {
  let ts = 100;
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/auth.test")) {
      return Response.json({ ok: true, team_id: "T1", user_id: "UBOT", bot_id: "BBOT" });
    }
    if (url.pathname.endsWith("/chat.postMessage") || url.pathname.endsWith("/chat.startStream")) {
      const body = JSON.parse(String(init?.body)) as Record<string, string | undefined>;
      const posted = String(ts++);
      platform.push({
        channel: String(body.channel),
        ts: posted,
        ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}),
        user: "UBOT",
        bot_id: "BBOT",
        text: body.markdown_text ?? body.text,
      });
      return Response.json({ ok: true, ts: posted });
    }
    if (/\/conversations\.(history|replies)$/.test(url.pathname)) return platformRead(url);
    return Response.json({ ok: true });
  });
}

/** A signed delivery of `envelope`; a message it carries is on the platform from then on, as on Slack. */
function signedRequest(envelope: unknown, options: { timestamp?: number; signature?: string } = {}): Request {
  const event = (envelope as SlackEventEnvelope).event;
  if (event?.channel && event.ts && !platform.some((m) => m.channel === event.channel && m.ts === event.ts)) {
    platform.push({
      channel: event.channel,
      ts: event.ts,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      ...(event.user ? { user: event.user } : {}),
      text: event.text,
    });
  }
  const body = JSON.stringify(envelope);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature =
    options.signature ?? `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://agent.test/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

function message(ts: string, input: Partial<NonNullable<SlackEventEnvelope["event"]>> = {}): SlackEventEnvelope {
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: `Ev-${ts}`,
    event: {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "hello",
      ts,
      ...input,
    },
  };
}

function slackBodies(fetchMock: ReturnType<typeof okFetch>, method: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([input]) => String(input).endsWith(`/${method}`))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

function mount(
  agent: Agent,
  options: Partial<SlackChannelOptions> = {},
  stateRoot = root(),
  stopped?: (session: string) => { stopped: string[] },
) {
  const handler = slackChannel({
    botToken: "xoxb-test",
    signingSecret: SECRET,
    apiBaseUrl: API,
    ...options,
  })(channelContext(stopped ? withStop(agent, stopped) : agent, stateRoot, "slack"))["POST /slack"]!;
  const turnsIdle = (handler as { turnsIdle?: () => Promise<void> }).turnsIdle ?? (async () => {});
  idles.add(turnsIdle);
  return { handler, stateRoot, turnsIdle };
}

/** The conversation a session talks for, as the channel recorded it. */
function conversationOf(stateRoot: string, sessionId: string | undefined): string | undefined {
  const recorded = JSON.parse(readFileSync(join(stateRoot, "channels", "slack", "sessions.json"), "utf8"));
  return Object.entries(recorded as Record<string, string>).find(([, id]) => id === sessionId)?.[0];
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([...idles].map((idle) => idle()));
}

afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  idles.clear();
  platform.length = 0;
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Slack signed ingress", () => {
  it("verifies the raw-body HMAC and rejects stale timestamps", () => {
    const body = '{"type":"url_verification","challenge":"x"}';
    const timestamp = "1700000000";
    const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    expect(verifySlackSignature(SECRET, timestamp, signature, body, 1_700_000_000_000)).toBe(true);
    expect(verifySlackSignature(SECRET, timestamp, signature, `${body} `, 1_700_000_000_000)).toBe(false);
    expect(verifySlackSignature(SECRET, timestamp, signature, body, 1_700_001_000_000)).toBe(false);
  });

  it("answers Slack's signed URL verification challenge and rejects a forged request", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent } = replyingAgent();
    const { handler } = mount(agent);
    const challenge = await handler(signedRequest({ type: "url_verification", challenge: "abc" }));
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: "abc" });
    expect((await handler(signedRequest(message("1.0"), { signature: "v0=bad" }))).status).toBe(401);
  });
});

describe("Slack sessions, context, and thread participation", () => {
  it("threads each top-level DM by default and settles the one preview message", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("hello back");
    const { handler, stateRoot } = mount(agent);
    await handler(signedRequest(message("1.0", { channel: "D1", channel_type: "im", text: "hi" })));
    await settle();

    // A DM's answer always opens its assistant thread, but the summon rule never consults
    // participation outside a group — so a DM must not spend a slot in the bounded cache.
    expect(existsSync(join(stateRoot, "channels", "slack", "thread-participants.json"))).toBe(false);

    expect(calls).toHaveLength(1);
    expect(conversationOf(stateRoot, calls[0]?.sessionId)).toBe("T1:D1:1.0");
    expect(calls[0]?.prompt.text).toContain("[slack: team T1, channel D1 (direct)");
    const methods = fetchMock.mock.calls.map(([url]) => String(url).split("/").pop());
    expect(methods).toContain("assistant.threads.setStatus");
    expect(methods).toContain("assistant.threads.setTitle");
    expect(methods).toContain("chat.startStream");
    expect(methods).toContain("chat.stopStream");
    const start = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat.startStream"));
    expect(JSON.parse(String(start?.[1]?.body))).toMatchObject({
      channel: "D1",
      thread_ts: "1.0",
      markdown_text: expect.stringContaining("hello back"),
    });
    expect(JSON.stringify(JSON.parse(String(start?.[1]?.body)))).not.toContain("AI-generated content");
  });

  it("a bare reply reaches the agent in a thread it answered in, while one human is in it", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent);
    await new Promise((resolve) => setImmediate(resolve));

    // Mentioning it inside a thread is the bootstrap: it answers, which makes it a participant.
    await handler(signedRequest(message("10.1", { type: "app_mention", text: "<@UBOT> inspect", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(conversationOf(stateRoot, calls[0]?.sessionId)).toBe("T1:C1:10.0");

    // A two-party thread no longer needs the name.
    await handler(signedRequest(message("10.2", { text: "bare follow-up", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(2);
    expect(conversationOf(stateRoot, calls[1]?.sessionId)).toBe("T1:C1:10.0");
  });
});

describe("Slack stop command", () => {
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
  const invoked: string[] = [];
  const agent = scriptedAgent(async function* (request) {
    yield ev.message();
    invoked.push(promptOf(request).text);
    yield ev.ended();
  });

  it("aborts the routed session, notifies, and never submits a turn", async () => {
    invoked.length = 0;
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { stopped, aborted } = fakeStop("stopped");
    const stateRoot = root();
    mkdirSync(join(stateRoot, "channels", "slack"), { recursive: true });
    writeFileSync(
      join(stateRoot, "channels", "slack", "sessions.json"),
      JSON.stringify({ "T1:D1:10.0": "session-dm" }),
    );
    const { handler } = mount(agent, {}, stateRoot, stopped);
    const res = await handler(signedRequest(message("10.0", { channel: "D1", channel_type: "im", text: "Stop!" })));
    expect(res.status).toBe(200);
    await settle(); // the abort runs after the acknowledgement: it waits for what it stops
    expect(aborted).toEqual(["session-dm"]);
    expect(invoked).toEqual([]); // a control action, never a turn
    expect(slackBodies(fetchMock, "chat.postMessage").map((b) => b.text)).toEqual(["⏹ Stopped."]);
  });
});

describe("Slack Socket Mode channel", () => {
  /** A Socket Mode connection a test drives: the socket Slack would give, and what the channel sent on it. */
  function socketMode(agent: Agent, options: { stateRoot?: string } = {}) {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) =>
      String(input).endsWith("/apps.connections.open")
        ? Response.json({ ok: true, url: "wss://wss.test/link" })
        : fetchMock(input, init),
    );
    let handlers: SlackSocketHandlers | undefined;
    const sent: unknown[] = [];
    const openSocket: OpenSlackSocket = (_url, given) => {
      handlers = given;
      return { send: (data) => sent.push(JSON.parse(data)), close: () => {} };
    };
    const abort = new AbortController();
    const stateRoot = options.stateRoot ?? root();
    const channel = slackSocketChannel(
      { botToken: "xoxb-test", appToken: "xapp-1-A1-1-abc", apiBaseUrl: API },
      { openSocket },
    );
    const connection = channel.connect(channelContext(agent, stateRoot, "slack"), abort.signal);
    connection.ready.catch(() => {});
    connection.closed.catch(() => {});
    return {
      channel,
      connection,
      abort,
      sent,
      fetchMock,
      stateRoot,
      /** Slack says `message` on the socket, once the channel has opened it. */
      say: async (message: unknown) => {
        await vi.waitFor(() => expect(handlers).toBeDefined());
        handlers?.message(JSON.stringify(message));
      },
    };
  }

  const delivery = (id: string, envelope: SlackEventEnvelope) => ({
    envelope_id: id,
    type: "events_api",
    accepts_response_payload: false,
    payload: envelope,
  });

  it("answers an event it received over the socket the way the webhook channel answers a signed one", async () => {
    const { agent, calls } = replyingAgent("hello back");
    const slack = socketMode(agent);
    expect(slack.channel.name).toBe("slack socket mode");
    await slack.say({ type: "hello" });
    await slack.connection.ready;
    await slack.say(delivery("E1", message("1.0", { channel: "D1", channel_type: "im", text: "hi" })));
    await vi.waitFor(() => expect(slack.sent).toEqual([{ envelope_id: "E1" }]));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // The same turn as a signed delivery: asked under the message's own key, steered.
    expect(calls.map((c) => [c.idempotencyKey, c.whenBusy])).toEqual([["T1:D1:1.0", "steer"]]);
    // …and the answer goes back through the Web API, as it does for a signed one.
    await vi.waitFor(() =>
      expect(slack.fetchMock.mock.calls.some(([input]) => /\/chat\.[a-zA-Z]+$/.test(String(input)))).toBe(true),
    );
    slack.abort.abort();
  });
});
