import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/agent.ts";
import { type SlackChannelOptions, type SlackEventEnvelope, slackChannel, verifySlackSignature } from "../src/slack.ts";

const SECRET = "slack-signing-secret";
const API = "https://slack.test/api";
const roots: string[] = [];
const idles = new Set<() => Promise<void>>();

function replyingAgent(reply = "done") {
  const calls: { scope: Scope; prompt: Prompt }[] = [];
  const agent: Agent = {
    async *invoke(scope, prompt): AsyncIterable<AgentEvent> {
      calls.push({ scope, prompt });
      if (reply) yield { type: "text", delta: reply };
      yield { type: "completed" };
    },
  };
  return { agent, calls };
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "fa-slack-"));
  roots.push(value);
  return value;
}

function okFetch() {
  let ts = 100;
  return vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth.test")) return Response.json({ ok: true, team_id: "T1", user_id: "UBOT" });
    if (url.endsWith("/chat.postMessage") || url.endsWith("/chat.startStream")) {
      return Response.json({ ok: true, ts: String(ts++) });
    }
    return Response.json({ ok: true });
  });
}

function signedRequest(envelope: unknown, options: { timestamp?: number; signature?: string } = {}): Request {
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

function writeTurns(stateRoot: string, turns: Record<string, unknown>): void {
  const home = join(stateRoot, "channels", "slack");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "turns.json"), JSON.stringify(turns));
}

function storedTurn(id: string, seq: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    seq,
    session: "recovery-session",
    baseText: id,
    bufferKey: "T1:C1",
    teamId: "T1",
    channelId: "C1",
    threadTs: "1.0",
    requesterUserId: "U1",
    fileIds: [],
    attempts: 0,
    ...extra,
  };
}

function mount(agent: Agent, options: Partial<SlackChannelOptions> = {}, stateRoot = root()) {
  const handler = slackChannel({
    botToken: "xoxb-test",
    signingSecret: SECRET,
    apiBaseUrl: API,
    ...options,
  })({ agent, stateRoot })["POST /slack"]!;
  const turnsIdle = (handler as { turnsIdle?: () => Promise<void> }).turnsIdle ?? (async () => {});
  idles.add(turnsIdle);
  return { handler, stateRoot, turnsIdle };
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
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Slack reaction ack", () => {
  const reactionCalls = (
    fetchMock: ReturnType<typeof okFetch>,
  ): { method: string | undefined; name: unknown; channel: unknown; timestamp: unknown }[] =>
    fetchMock.mock.calls
      .filter(([url]) => /\/reactions\.(add|remove)$/.test(String(url)))
      .map(([url, init]) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return {
          method: String(url).split("/").pop(),
          name: body.name,
          channel: body.channel,
          timestamp: body.timestamp,
        };
      });

  it("adds the processing reaction on the triggering message and swaps it for completed on success", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { handler } = mount(replyingAgent("hello back").agent);
    await handler(signedRequest(message("1.0", { channel: "D1", channel_type: "im", text: "hi" })));
    await settle();
    expect(reactionCalls(fetchMock)).toEqual([
      { method: "reactions.add", name: "eyes", channel: "D1", timestamp: "1.0" },
      { method: "reactions.remove", name: "eyes", channel: "D1", timestamp: "1.0" },
      { method: "reactions.add", name: "white_check_mark", channel: "D1", timestamp: "1.0" },
    ]);
  });

  it("honors reactionAck:false and custom emoji names", async () => {
    const off = okFetch();
    vi.stubGlobal("fetch", off);
    const disabled = mount(replyingAgent().agent, { reactionAck: false });
    await disabled.handler(signedRequest(message("1.0", { channel: "D1", channel_type: "im", text: "hi" })));
    await settle();
    expect(reactionCalls(off)).toHaveLength(0);

    const custom = okFetch();
    vi.stubGlobal("fetch", custom);
    const { handler } = mount(replyingAgent().agent, {
      reactionAck: { processing: ":hourglass_flowing_sand:", completed: "heavy_check_mark" },
    });
    await handler(signedRequest(message("1.5", { channel: "D1", channel_type: "im", text: "hi" })));
    await settle();
    expect(reactionCalls(custom).map((call) => call.name)).toEqual([
      "hourglass_flowing_sand",
      "hourglass_flowing_sand",
      "heavy_check_mark",
    ]);
  });

  it("keeps the turn's reply when the reaction API fails", async () => {
    let ts = 100;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/auth.test")) return Response.json({ ok: true, team_id: "T1", user_id: "UBOT" });
      if (url.endsWith("/reactions.add")) return Response.json({ ok: false, error: "missing_scope" });
      if (url.endsWith("/chat.postMessage") || url.endsWith("/chat.startStream")) {
        return Response.json({ ok: true, ts: String(ts++) });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { handler } = mount(replyingAgent("still replies").agent);
    await handler(signedRequest(message("1.0", { channel: "D1", channel_type: "im", text: "hi" })));
    await settle();
    const methods = fetchMock.mock.calls.map(([url]) => String(url).split("/").pop());
    expect(methods).toContain("chat.startStream");
  });
});

describe("Slack first-run welcome", () => {
  const appHome = (input: Partial<NonNullable<SlackEventEnvelope["event"]>> = {}): SlackEventEnvelope => ({
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev-home",
    event: { type: "app_home_opened", user: "U1", channel: "D1", tab: "messages", ...input },
  });
  const welcomeBodies = (fetchMock: ReturnType<typeof okFetch>): string[] =>
    slackBodies(fetchMock, "chat.postMessage")
      .map((body) => String(body.markdown_text ?? ""))
      .filter(Boolean);

  it("sends a one-time welcome on first DM open, without invoking the agent", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent();
    const { handler } = mount(agent);
    await handler(signedRequest(appHome()));
    await settle();
    const welcomes = welcomeBodies(fetchMock);
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0]).toContain("AI agent here to help");
    expect(calls).toHaveLength(0);
  });

  it("does not repeat the welcome on later opens, durably across a restart", async () => {
    const stateRoot = root();
    const first = okFetch();
    vi.stubGlobal("fetch", first);
    const a = mount(replyingAgent().agent, {}, stateRoot);
    await a.handler(signedRequest(appHome()));
    await settle();
    expect(welcomeBodies(first)).toHaveLength(1);

    const second = okFetch();
    vi.stubGlobal("fetch", second);
    const b = mount(replyingAgent().agent, {}, stateRoot);
    await b.handler(signedRequest(appHome()));
    await settle();
    expect(welcomeBodies(second)).toHaveLength(0);
  });

  it("ignores non-messages tabs", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { handler } = mount(replyingAgent().agent);
    await handler(signedRequest(appHome({ tab: "home" })));
    await settle();
    expect(welcomeBodies(fetchMock)).toHaveLength(0);
  });

  it("disables the welcome with welcome:false and honors a custom string", async () => {
    const off = okFetch();
    vi.stubGlobal("fetch", off);
    const disabled = mount(replyingAgent().agent, { welcome: false });
    await disabled.handler(signedRequest(appHome()));
    await settle();
    expect(welcomeBodies(off)).toHaveLength(0);

    const custom = okFetch();
    vi.stubGlobal("fetch", custom);
    const { handler } = mount(replyingAgent().agent, { welcome: "Custom hi there" });
    await handler(signedRequest(appHome({ user: "U2" })));
    await settle();
    expect(welcomeBodies(custom)).toEqual(["Custom hi there"]);
  });
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

  it("rejects invalid session, rendering, task-display, and reaction policies at construction", () => {
    expect(() =>
      slackChannel({
        botToken: "xoxb-test",
        signingSecret: SECRET,
        groupMessageSession: "invalid" as "threaded",
      }),
    ).toThrow(/groupMessageSession/);
    expect(() =>
      slackChannel({
        botToken: "xoxb-test",
        signingSecret: SECRET,
        rendering: "invalid" as "native",
      }),
    ).toThrow(/rendering/);
    expect(() =>
      slackChannel({
        botToken: "xoxb-test",
        signingSecret: SECRET,
        taskDisplay: "invalid" as "dense",
      }),
    ).toThrow(/taskDisplay/);
    expect(() =>
      slackChannel({
        botToken: "xoxb-test",
        signingSecret: SECRET,
        reactionAck: { processing: "not valid!" },
      }),
    ).toThrow(/reactionAck/);
  });

  it("refuses to ACK work when auth.test proves the bot token is unusable", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ ok: false, error: "invalid_auth" }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, calls } = replyingAgent();
    const { handler } = mount(agent);

    const response = await handler(signedRequest(message("0.5", { type: "app_mention" })));

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
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

describe("Slack sessions, context, and managed threads", () => {
  it("threads each top-level DM by default and settles the one preview message", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("hello back");
    const { handler } = mount(agent);
    await handler(signedRequest(message("1.0", { channel: "D1", channel_type: "im", text: "hi" })));
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("slack:T1:D1:1.0");
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
      chunks: [{ type: "markdown_text", text: expect.stringContaining("hello back") }],
      task_display_mode: "plan",
    });
    expect(JSON.stringify(JSON.parse(String(start?.[1]?.body)))).not.toContain("AI-generated content");
  });

  it("routes the configured taskDisplay into the native stream's task_display_mode", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("hello back");
    const { handler } = mount(agent, { taskDisplay: "timeline" });
    await handler(signedRequest(message("1.0", { channel: "D1", channel_type: "im", text: "hi" })));
    await settle();

    expect(slackBodies(fetchMock, "chat.startStream")[0]).toMatchObject({ task_display_mode: "timeline" });
  });

  it("renders safe native task updates without exposing reasoning or tool arguments", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    let prompt: Prompt | undefined;
    const agent: Agent = {
      async *invoke(_scope, value): AsyncIterable<AgentEvent> {
        prompt = value;
        yield { type: "thinking", delta: "private chain of thought: launch-code" };
        yield { type: "tool_started", id: "t1", name: "search", args: { token: "tool-secret" } };
        yield { type: "tool_ended", id: "t1", isError: false, content: { result: "internal" } };
        yield { type: "text", delta: "# Safe answer\n\n**Done.** Do not ping <!channel>." };
        yield { type: "completed" };
      },
    };
    const { handler } = mount(agent, { aiDisclaimer: "Custom policy footer." });
    await handler(
      signedRequest(
        message("1.5", {
          channel: "D1",
          channel_type: "im",
          text: "run safely",
          app_context: { entities: [{ type: "slack#/types/channel_id", value: "C99", team_id: "T1" }] },
        }),
      ),
    );
    await settle();

    expect(prompt?.text).toContain("slack#/types/channel_id=C99");
    expect(prompt?.text).toContain("Format your reply as standard Markdown");
    const outbound = fetchMock.mock.calls
      .filter(([input]) => !String(input).endsWith("/auth.test"))
      .map(([, init]) => String(init?.body))
      .join("\n");
    expect(outbound).not.toContain("launch-code");
    expect(outbound).not.toContain("tool-secret");
    expect(outbound).not.toContain("<!channel>");
    expect(outbound).toContain("&lt;!channel>");
    expect(outbound).toContain("Custom policy footer.");
    expect(slackBodies(fetchMock, "chat.startStream")[0]).toMatchObject({
      chunks: [{ type: "task_update", id: "t1", title: "Search", status: "in_progress" }],
    });
    expect(slackBodies(fetchMock, "chat.appendStream")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunks: [{ type: "task_update", id: "t1", title: "Search", status: "complete" }],
        }),
        expect.objectContaining({
          chunks: [{ type: "markdown_text", text: expect.stringContaining("# Safe answer") }],
        }),
      ]),
    );
  });

  it("keeps one linear DM session when continuous mode is explicitly selected", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent();
    const { handler } = mount(agent, { directMessageSession: "continuous" });
    await handler(signedRequest(message("1.0", { channel: "D1", channel_type: "im", text: "first" })));
    await settle();

    expect(calls[0]?.scope.session).toBe("slack:T1:D1");
    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat.postMessage"));
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ markdown_text: expect.stringContaining("done") });
    expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty("thread_ts");
  });

  it("defaults to context-aware groups, owns the summoned thread, and dedups logical messages", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent);
    await new Promise((resolve) => setImmediate(resolve)); // auth.test resolves bot identity

    await handler(signedRequest(message("1.0", { text: "the deploy is broken" })));
    const bufferPath = join(stateRoot, "channels", "slack", "buffers.json");
    expect(readFileSync(bufferPath, "utf8")).toContain("the deploy is broken");

    await handler(signedRequest(message("2.0", { type: "app_mention", text: "<@UBOT> investigate" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("slack:T1:C1:2.0");
    expect(calls[0]?.prompt.text).toContain("the deploy is broken");

    await handler(signedRequest(message("3.0", { text: "compare yesterday too", thread_ts: "2.0" })));
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.scope.session).toBe("slack:T1:C1:2.0");

    await handler(
      signedRequest({
        ...message("3.0", { type: "app_mention", text: "<@UBOT> duplicate", thread_ts: "2.0" }),
        event_id: "different",
      }),
    );
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("answers inside an existing human thread without adopting its later bare replies", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "context" });
    await new Promise((resolve) => setImmediate(resolve));

    await handler(signedRequest(message("10.1", { type: "app_mention", text: "<@UBOT> inspect", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("slack:T1:C1:10.0");

    await handler(signedRequest(message("10.2", { text: "bare follow-up", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(stateRoot, "channels", "slack", "buffers.json"), "utf8")).toContain("bare follow-up");
  });

  it("supports Feishu-compatible continuous top-level group sessions without creating ownership", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent();
    const { handler } = mount(agent, { groupBehavior: "context", groupMessageSession: "continuous" });
    await new Promise((resolve) => setImmediate(resolve));

    await handler(signedRequest(message("20.0", { type: "app_mention", text: "<@UBOT> top level" })));
    await settle();
    expect(calls[0]?.scope.session).toBe("slack:T1:C1");

    await handler(signedRequest(message("20.1", { text: "not managed", thread_ts: "20.0" })));
    await settle();
    expect(calls).toHaveLength(1);

    await handler(
      signedRequest(message("21.1", { type: "app_mention", text: "<@UBOT> existing topic", thread_ts: "21.0" })),
    );
    await settle();
    expect(calls[1]?.scope.session).toBe("slack:T1:C1:21.0");

    const posts = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/chat.postMessage"))
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(posts[0]).not.toHaveProperty("thread_ts");
    const streams = slackBodies(fetchMock, "chat.startStream");
    expect(streams[0]).toMatchObject({ thread_ts: "21.0", recipient_user_id: "U1", recipient_team_id: "T1" });
  });

  it("keeps mention-only mode available explicitly without buffering group traffic", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "mentions" });
    await new Promise((resolve) => setImmediate(resolve));

    await handler(signedRequest(message("1.0", { text: "background" })));
    await handler(signedRequest(message("2.0", { type: "app_mention", text: "<@UBOT> answer" })));
    await settle();
    await handler(signedRequest(message("3.0", { text: "bare reply", thread_ts: "2.0" })));
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt.text).not.toContain("background");
    expect(() => readFileSync(join(stateRoot, "channels", "slack", "buffers.json"), "utf8")).toThrow();
  });

  it("persists a turn before ACK and uses only Slack file IDs in the intent", async () => {
    vi.stubGlobal("fetch", okFetch());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        await gate;
        yield { type: "completed" };
      },
    };
    const { handler, stateRoot } = mount(agent);
    const event = message("4.0", {
      type: "app_mention",
      text: "<@UBOT> read this",
      subtype: "file_share",
      files: [{ id: "F1", name: "secret.txt", url_private: "https://temporary.example/file" }],
    });
    const response = await handler(signedRequest(event));
    expect(response.status).toBe(200);
    const turns = readFileSync(join(stateRoot, "channels", "slack", "turns.json"), "utf8");
    expect(turns).toContain('"fileIds":["F1"]');
    expect(turns).not.toContain("temporary.example");
    release();
  });

  it("replays a crash-surviving turn on a second mount without a new Slack event", async () => {
    vi.stubGlobal("fetch", okFetch());
    const stateRoot = root();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const firstCalls: { scope: Scope; prompt: Prompt }[] = [];
    const interruptedAgent: Agent = {
      async *invoke(scope, prompt): AsyncIterable<AgentEvent> {
        firstCalls.push({ scope, prompt });
        await gate;
        yield { type: "completed" };
      },
    };
    const first = mount(interruptedAgent, {}, stateRoot);
    await first.handler(
      signedRequest(message("5.0", { type: "app_mention", text: "<@UBOT> recover this exact request" })),
    );
    const turnsPath = join(stateRoot, "channels", "slack", "turns.json");
    const crashSnapshot = readFileSync(turnsPath, "utf8");

    release();
    await first.turnsIdle();
    writeFileSync(turnsPath, crashSnapshot);

    const replayed = replyingAgent("recovered");
    const second = mount(replayed.agent, {}, stateRoot);
    await second.turnsIdle();

    expect(replayed.calls).toHaveLength(1);
    expect(replayed.calls[0]).toEqual(firstCalls[0]);
    expect(replayed.calls[0]?.prompt.text).toContain("recover this exact request");
    expect(JSON.parse(readFileSync(turnsPath, "utf8"))).toEqual({});
  });

  it("recovers in seq order and allocates new seq above the recovered maximum", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const stateRoot = root();
    writeTurns(stateRoot, {
      late: storedTurn("late", 9, { baseText: "recovered late" }),
      early: storedTurn("early", 4, { baseText: "recovered early" }),
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: { scope: Scope; prompt: Prompt }[] = [];
    let invocation = 0;
    const agent: Agent = {
      async *invoke(scope, prompt): AsyncIterable<AgentEvent> {
        calls.push({ scope, prompt });
        if (++invocation === 1) await gate;
        yield { type: "completed" };
      },
    };
    const { handler, turnsIdle } = mount(
      agent,
      { route: () => ({ session: "recovery-session", text: "fresh request" }) },
      stateRoot,
    );

    await handler(signedRequest(message("30.0", { text: "new event after restart" })));
    const during = JSON.parse(readFileSync(join(stateRoot, "channels", "slack", "turns.json"), "utf8")) as Record<
      string,
      { seq?: number }
    >;
    expect(during["T1:C1:30.0"]?.seq).toBe(10);

    release();
    await turnsIdle();
    expect(calls.map((call) => call.prompt.text)).toEqual([
      expect.stringContaining("recovered early"),
      expect.stringContaining("recovered late"),
      expect.stringContaining("fresh request"),
    ]);
  });

  it("drops a recovered turn over the execution ceiling and notifies the asker", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stateRoot = root();
    writeTurns(stateRoot, {
      poison: storedTurn("poison", 1, { baseText: "must not run", attempts: 3 }),
    });
    const { agent, calls } = replyingAgent("should not run");
    const { turnsIdle } = mount(agent, {}, stateRoot);

    await turnsIdle();
    expect(calls).toHaveLength(0);
    await vi.waitFor(() => {
      expect(
        slackBodies(fetchMock, "chat.postMessage").some((body) =>
          String(body.text).includes("couldn’t complete an earlier request"),
        ),
      ).toBe(true);
    });
    expect(JSON.parse(readFileSync(join(stateRoot, "channels", "slack", "turns.json"), "utf8"))).toEqual({});
  });

  it("defers recovered turns when the attempt bump cannot persist and settles an existing queue preview", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stateRoot = root();
    writeTurns(stateRoot, {
      first: storedTurn("first", 1, { baseText: "first deferred" }),
      second: storedTurn("second", 2, { baseText: "second deferred" }),
    });
    const { agent, calls } = replyingAgent("should not run");
    const { turnsIdle } = mount(agent, {}, stateRoot);
    mkdirSync(join(stateRoot, "channels", "slack", "turns.json.tmp"));

    await turnsIdle();
    expect(calls).toHaveLength(0);
    const onDisk = JSON.parse(readFileSync(join(stateRoot, "channels", "slack", "turns.json"), "utf8")) as Record<
      string,
      { attempts?: number }
    >;
    expect(Object.keys(onDisk)).toEqual(["first", "second"]);
    expect(Object.values(onDisk).map((turn) => turn.attempts)).toEqual([0, 0]);
    await vi.waitFor(() => {
      expect(
        slackBodies(fetchMock, "chat.update").some((body) =>
          String(body.text).includes("Delayed by a temporary system issue"),
        ),
      ).toBe(true);
    });
    const customerText = [...slackBodies(fetchMock, "chat.postMessage"), ...slackBodies(fetchMock, "chat.update")]
      .map((body) => String(body.text))
      .join("\n");
    expect(customerText).not.toContain("complete an earlier request");
  });
});
