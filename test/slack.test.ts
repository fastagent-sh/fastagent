import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/agent.ts";
import { mentionsSlackUser } from "../src/channels/slack/parse.ts";
import { NO_ACTIVE_RUN_CODE, type SessionCommand, type SessionControl } from "../src/session.ts";
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

function mount(agent: Agent, options: Partial<SlackChannelOptions> = {}, stateRoot = root(), control?: SessionControl) {
  const handler = slackChannel({
    botToken: "xoxb-test",
    signingSecret: SECRET,
    apiBaseUrl: API,
    ...options,
  })({ agent, stateRoot, control })["POST /slack"]!;
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

  it("refuses a removed session option instead of silently changing placement and memory under it", () => {
    // The migration guarantee: an upgraded workspace still passing a mode fails loudly at construction
    // rather than starting fine with a different place, a different session, and a different renderer.
    expect(() =>
      slackChannel({ botToken: "xoxb-test", signingSecret: SECRET, groupMessageSession: "continuous" } as never),
    ).toThrow(/groupMessageSession/);
    expect(() =>
      slackChannel({ botToken: "xoxb-test", signingSecret: SECRET, directMessageSession: "threaded" } as never),
    ).toThrow(/directMessageSession/);
  });

  it("rejects invalid rendering, task-display, and reaction policies at construction", () => {
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
      markdown_text: expect.stringContaining("hello back"),
    });
    expect(JSON.stringify(JSON.parse(String(start?.[1]?.body)))).not.toContain("AI-generated content");
  });

  it("renders concise native tool traces without exposing reasoning or successful tool output", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    let prompt: Prompt | undefined;
    const agent: Agent = {
      async *invoke(_scope, value): AsyncIterable<AgentEvent> {
        prompt = value;
        yield { type: "thinking", delta: "private chain of thought: launch-code" };
        yield { type: "tool_started", id: "t1", name: "search", args: { query: "public docs" } };
        yield { type: "tool_ended", id: "t1", isError: false, content: { result: "internal result" } };
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
    expect(outbound).toContain("public docs");
    expect(outbound).not.toContain("internal result");
    expect(outbound).not.toContain("<!channel>");
    expect(outbound).toContain("&lt;!channel>");
    expect(outbound).toContain("Custom policy footer.");
    expect(slackBodies(fetchMock, "chat.startStream")[0]).toMatchObject({
      markdown_text: expect.stringContaining("**Search** — `public docs`"),
    });
    expect(slackBodies(fetchMock, "chat.appendStream")).toEqual(
      expect.arrayContaining([expect.objectContaining({ markdown_text: expect.stringContaining("# Safe answer") })]),
    );
  });

  it("defaults to context-aware groups, records participation in the thread its answer creates, and dedups logical messages", async () => {
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

  it("records participation even where no rule reads it, so a posture change cannot leave a gap", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "mentions" });
    await new Promise((resolve) => setImmediate(resolve));

    await handler(signedRequest(message("30.1", { type: "app_mention", text: "<@UBOT> hi", thread_ts: "30.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    // A second human summons it in the same thread — an `app_mention`, which IS delivered under
    // `mentions` (a bare channel message is not, which is why the posture's under-count is documented
    // as accepted in §3 rather than defended against here). Nothing reads participation in this
    // posture, but the posture is configuration and this record outlives a change to it: skipping the
    // write would leave `agentSpoke` on disk with U2 missing, and after a switch back to `context` the
    // agent would barge into a thread it believes is two-party.
    await handler(
      signedRequest(message("30.2", { user: "U2", type: "app_mention", text: "<@UBOT> and also", thread_ts: "30.0" })),
    );
    await settle();

    const path = join(stateRoot, "channels", "slack", "thread-participants.json");
    expect(existsSync(path)).toBe(true);
    const record = (JSON.parse(readFileSync(path, "utf8")) as Record<string, { humans: string[] }>)["slack:T1:C1:30.0"];
    expect(record?.humans.sort()).toEqual(["U1", "U2"]);
  });

  it("removes the obsolete owned-threads.json on the next start", async () => {
    vi.stubGlobal("fetch", okFetch());
    const stateRoot = root();
    const home = join(stateRoot, "channels", "slack");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "owned-threads.json"), JSON.stringify({ "T1:C1:1.0": { rootTs: "1.0" } }));

    const { agent } = replyingAgent();
    mount(agent, {}, stateRoot);

    expect(existsSync(join(home, "owned-threads.json"))).toBe(false);
  });

  it("a bare reply reaches the agent in a thread it answered in, while one human is in it", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler } = mount(agent, { groupBehavior: "context" });
    await new Promise((resolve) => setImmediate(resolve));

    // Mentioning it inside a thread is the bootstrap: it answers, which makes it a participant.
    await handler(signedRequest(message("10.1", { type: "app_mention", text: "<@UBOT> inspect", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("slack:T1:C1:10.0");

    // A two-party thread no longer needs the name.
    await handler(signedRequest(message("10.2", { text: "bare follow-up", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.scope.session).toBe("slack:T1:C1:10.0");
  });

  it("a bare message that mentions only other people is discussion, not an ask", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "context" });
    await new Promise((resolve) => setImmediate(resolve));
    await handler(signedRequest(message("14.1", { type: "app_mention", text: "<@UBOT> hi", thread_ts: "14.0" })));
    await settle();
    expect(calls).toHaveLength(1);

    // The agent takes part and one human is here, but this message addresses someone else.
    await handler(signedRequest(message("14.2", { text: "<@U9> can you look?", thread_ts: "14.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(stateRoot, "channels", "slack", "buffers.json"), "utf8")).toContain("can you look?");
  });

  it("a bot id carrying regex metacharacters is matched, not interpreted", () => {
    // `auth.test`'s user_id is not validated here and this runs on every group message: interpolating
    // it raw would either mis-answer the summon question or throw on the acceptance path, which Slack
    // answers with an endless redelivery.
    expect(mentionsSlackUser("hi <@U.+> there", "U.+")).toBe(true);
    expect(mentionsSlackUser("hi <@UBOT> there", "U.+")).toBe(false);
    expect(mentionsSlackUser("hi <@UBOT|agent> there", "UBOT")).toBe(true);
  });

  it("a broadcast is not a possible summon, so it buffers while the bot identity is unresolved", async () => {
    // auth.test succeeds without a user_id, so botUserId stays undefined: a message mentioning a USER
    // is deferred (it might be the bot). A broadcast never can be, so deferring it would drop it.
    const base = okFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) =>
        String(input).endsWith("/auth.test")
          ? Response.json({ ok: true, team_id: "T1" })
          : base(input, init as RequestInit),
      ),
    );
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "context" });

    await handler(signedRequest(message("50.1", { text: "<!here> standup in five" })));
    await settle();

    expect(calls).toHaveLength(0);
    expect(readFileSync(join(stateRoot, "channels", "slack", "buffers.json"), "utf8")).toContain("standup in five");
  });

  it("the labelled mention form counts too, on both sides of the guard", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "context" });
    await new Promise((resolve) => setImmediate(resolve));

    // `<@UBOT|agent>` is a summon, not background text.
    await handler(signedRequest(message("40.1", { text: "<@UBOT|agent> take a look", thread_ts: "40.0" })));
    await settle();
    expect(calls).toHaveLength(1);

    // …and `<@U9|dana>` is a message aimed at a colleague: discussion, even in a thread the agent
    // takes part in and where it has heard only one human.
    await handler(signedRequest(message("40.2", { text: "<@U9|dana> what do you think?", thread_ts: "40.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(stateRoot, "channels", "slack", "buffers.json"), "utf8")).toContain("what do you think?");

    // A broadcast addresses the room, not the Agent: discussion, like any mention of other people.
    await handler(signedRequest(message("40.4", { text: "<!here> can someone look at this?", thread_ts: "40.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(stateRoot, "channels", "slack", "buffers.json"), "utf8")).toContain("look at this");

    // …and the stop command must survive the strip in either form, or it becomes an ordinary turn
    // queued behind the very run it meant to stop.
    await handler(signedRequest(message("40.3", { text: "<@UBOT|agent> stop", thread_ts: "40.0" })));
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("a top-level ask counts as heard in the thread the answer creates, so a stranger's reply does not summon", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "context" });
    await new Promise((resolve) => setImmediate(resolve));

    // U1 asks at CHANNEL top level: the ask carries no thread_ts, so the observation on the way in
    // never runs for it — the agent's answer is what creates thread 20.0.
    await handler(signedRequest(message("20.0", { type: "app_mention", text: "<@UBOT> look at this" })));
    await settle();
    expect(calls).toHaveLength(1);

    // U2 bare-replies inside that thread. Two humans are demonstrably here (U1's ask IS the root), so
    // this must stay listening rather than read as a two-party exchange.
    await handler(signedRequest(message("20.1", { user: "U2", text: "which part?", thread_ts: "20.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(stateRoot, "channels", "slack", "buffers.json"), "utf8")).toContain("which part?");
  });

  it("a second human in the thread restores the mention requirement, and the agent keeps listening", async () => {
    vi.stubGlobal("fetch", okFetch());
    const { agent, calls } = replyingAgent();
    const { handler, stateRoot } = mount(agent, { groupBehavior: "context" });
    await new Promise((resolve) => setImmediate(resolve));

    await handler(signedRequest(message("10.1", { type: "app_mention", text: "<@UBOT> inspect", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(1);

    // A second human SPEAKS — which is how the agent learns of them, the rule being defined over what
    // it heard rather than over the thread's true membership.
    await handler(signedRequest(message("10.2", { user: "U2", text: "I think it is the cache", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(1);

    // Addressing is ambiguous again, so even the original asker now needs the name.
    await handler(signedRequest(message("10.3", { text: "bare follow-up", thread_ts: "10.0" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(stateRoot, "channels", "slack", "buffers.json"), "utf8")).toContain("bare follow-up");

    // …and the discussion it stayed quiet through is folded into the next answered turn.
    await handler(
      signedRequest(message("10.4", { type: "app_mention", text: "<@UBOT> summarize", thread_ts: "10.0" })),
    );
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt.text).toContain("I think it is the cache");
    expect(calls[1]?.prompt.text).toContain("bare follow-up");
  });

  it("attaches an answer to its question with a thread, and that thread carries the memory", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent();
    const { handler } = mount(agent, { groupBehavior: "context" });
    await new Promise((resolve) => setImmediate(resolve));

    // Slack has no quote primitive, so answering in place means opening a thread on the ask — and the
    // thread is then the place, so its session is where the exchange lives (§4/§5).
    await handler(signedRequest(message("20.0", { type: "app_mention", text: "<@UBOT> top level" })));
    await settle();
    expect(calls[0]?.scope.session).toBe("slack:T1:C1:20.0");
    const stream = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat.startStream"));
    expect(JSON.parse(String(stream?.[1]?.body))).toMatchObject({ thread_ts: "20.0" });

    // A continuation inside that thread is the same place, hence the same session.
    await handler(signedRequest(message("20.1", { text: "and the follow-up", thread_ts: "20.0" })));
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.scope.session).toBe("slack:T1:C1:20.0");
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

describe("Slack stop command", () => {
  const fakeControl = (result: { ok: true } | { code: string }) => {
    const dispatched: { session: string; command: SessionCommand }[] = [];
    const control = {
      dispatch: async (session: string, command: SessionCommand) => {
        dispatched.push({ session, command });
        return "ok" in result
          ? { ok: true as const }
          : { ok: false as const, error: { code: result.code, message: "no run", retryable: false } };
      },
    } as unknown as SessionControl;
    return { control, dispatched };
  };
  const invoked: string[] = [];
  const agent: Agent = {
    async *invoke(_scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      invoked.push(prompt.text);
      yield { type: "completed" };
    },
  };

  it("aborts the routed session, notifies, and never submits a turn", async () => {
    invoked.length = 0;
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { control, dispatched } = fakeControl({ ok: true });
    const { handler, turnsIdle } = mount(agent, {}, root(), control);
    const res = await handler(signedRequest(message("10.0", { channel: "D1", channel_type: "im", text: "Stop!" })));
    expect(res.status).toBe(200);
    await turnsIdle();
    expect(dispatched).toEqual([{ session: "slack:T1:D1:10.0", command: { type: "abort" } }]);
    expect(invoked).toEqual([]); // a control action, never a turn
    expect(slackBodies(fetchMock, "chat.postMessage").map((b) => b.text)).toEqual(["⏹ Stopped."]);
  });

  it("maps no_active_run to the idle notice and degrades visibly without a control hub", async () => {
    invoked.length = 0;
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { control } = fakeControl({ code: NO_ACTIVE_RUN_CODE });
    const withHub = mount(agent, {}, root(), control);
    await withHub.handler(signedRequest(message("11.0", { channel: "D1", channel_type: "im", text: "cancel" })));
    await withHub.turnsIdle();
    const noHub = mount(agent, {}, root());
    await noHub.handler(signedRequest(message("12.0", { channel: "D1", channel_type: "im", text: "stop" })));
    await noHub.turnsIdle();
    expect(invoked).toEqual([]);
    const texts = slackBodies(fetchMock, "chat.postMessage").map((b) => String(b.text));
    expect(texts[0]).toBe("Nothing is running.");
    expect(texts[1]).toContain("Stop isn't enabled");
  });
});
