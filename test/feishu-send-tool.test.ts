/**
 * The `{feishu,lark}-send` scaffold tool. The two files are the same tool bound to a different cloud,
 * so what differs per cloud (gateway, credential isolation) runs for BOTH, and what does not (the
 * description contract, input validation, card/text encoding, transport reuse) runs once.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuChannel } from "../src/feishu.ts";
import type { Needs } from "../src/harnesses/pi-durable/define.ts";
import { larkChannel } from "../src/lark.ts";
import { scriptedAgent } from "./scripted-agent.ts";

function stubOpenApi() {
  const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
    if (url.includes("tenant_access_token")) {
      return Response.json({ code: 0, tenant_access_token: body.app_id, expire: 7200 });
    }
    if (url.includes("/bot/v3/info")) return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
    if (url.includes("/application/v6/scopes")) {
      return Response.json({
        code: 0,
        data: {
          scopes: ["im:message.group_msg", "im:message:readonly"].map((scope_name) => ({
            scope_name,
            grant_status: 1,
          })),
        },
      });
    }
    return Response.json({ code: 0, data: { message_id: "om_1" } });
  });
  return calls;
}

const agent = scriptedAgent(() => []);

/** Loads one cloud's scaffold tool, built with app credentials, and gives every test a fresh state root. */
function cloudFixture(kind: "feishu" | "lark", prefix: "FEISHU" | "LARK") {
  const state = { declared: undefined as unknown as Needs<ToolRegistration>, cwd: "", appId: "" };
  beforeAll(async () => {
    // Scaffold files import the published package; Vitest aliases it to the current source.
    const path = new URL(`../src/channels/${kind}/scaffold/${kind}-send.ts`, import.meta.url).pathname;
    state.declared = ((await import(path)) as { default: Needs<ToolRegistration> }).default;
  });
  let apps = 0;
  beforeEach(async () => {
    state.cwd = await mkdtemp(join(tmpdir(), `fa-${kind}-send-`));
    // A process keeps one transport per app: a fresh app per test starts with no token cached.
    state.appId = `cli_env_${++apps}`;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await rm(state.cwd, { recursive: true, force: true });
  });
  const tool = (appId = state.appId) =>
    state.declared.build({ [`${prefix}_APP_ID`]: appId, [`${prefix}_APP_SECRET`]: "env-secret" });
  return {
    tool,
    get cwd() {
      return state.cwd;
    },
    get appId() {
      return state.appId;
    },
    execute: async (params: unknown, appId?: string) => {
      const result = await tool(appId).execute(params as never, {} as never, {} as never);
      return { details: (result.output?.[0] as { text: string } | undefined)?.text };
    },
  };
}

describe.each([
  { kind: "feishu", prefix: "FEISHU", base: "https://open.feishu.cn", channel: feishuChannel, other: larkChannel },
  { kind: "lark", prefix: "LARK", base: "https://open.larksuite.com", channel: larkChannel, other: feishuChannel },
] as const)("scaffold $kind-send: the cloud it is bound to", ({ kind, prefix, base, channel, other }) => {
  const fx = cloudFixture(kind, prefix);

  it("sends plain text through the correct cloud with the app it was built with", async () => {
    const calls = stubOpenApi();
    expect((await fx.execute({ chatId: "oc_42", text: "digest ready" })).details).toBe("sent message to chat oc_42");
    expect(calls[0]?.body).toEqual({ app_id: fx.appId, app_secret: "env-secret" });
    expect(calls[1]).toEqual({
      url: `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      authorization: `Bearer ${fx.appId}`,
      body: { receive_id: "oc_42", msg_type: "text", content: JSON.stringify({ text: "digest ready" }) },
    });
    expect(calls.every((call) => call.url.startsWith(`${base}/`))).toBe(true);
  });

  it("sends through the mounted channel of its app, at that channel's gateway, keeping both clouds isolated", async () => {
    const calls = stubOpenApi();
    const ctx = { stateRoot: join(fx.cwd, ".state"), agent: agent };
    channel({
      appId: "cli_channel",
      appSecret: "channel-secret",
      verificationToken: "v",
      apiBaseUrl: `https://${kind}.test`,
    })(ctx);
    other({ appId: "cli_other", appSecret: "other-secret", verificationToken: "v", apiBaseUrl: "https://other.test" })(
      ctx,
    );
    // Wait for the channel's startup identity/scope requests before checking the tool's send.
    await vi.waitFor(() => expect(calls.filter((call) => call.url.endsWith("/application/v6/scopes"))).toHaveLength(2));
    await fx.execute({ chatId: "oc_1", text: "scheduled update" }, "cli_channel");
    expect(calls.at(-1)).toMatchObject({
      url: `https://${kind}.test/open-apis/im/v1/messages?receive_id_type=chat_id`,
      authorization: "Bearer cli_channel",
    });
  });
});

// The lark file is the feishu file with the cloud swapped (the tests above pin that swap), so the tool
// behaviour itself is exercised once.
describe("scaffold feishu-send: the tool itself", () => {
  const fx = cloudFixture("feishu", "FEISHU");

  it("states the destination rule and avoids duplicating a normal chat reply", () => {
    expect(fx.tool().description).toMatch(/do not call this to answer/i);
    expect(fx.tool().description).toMatch(/post the message twice/i);
    expect(fx.tool().description).toMatch(/OUTSIDE the normal reply path/);
    expect(fx.tool().description).toMatch(/must come from your instructions/i);
    expect(fx.tool().description).toMatch(/only identifies the chat you are answering/i);
  });

  it("sends Markdown as an inline static card", async () => {
    const calls = stubOpenApi();
    expect((await fx.execute({ chatId: "oc_7", markdown: "# Report\n**done**" })).details).toBe(
      "sent card to chat oc_7",
    );
    const send = calls[1];
    expect(send?.body.msg_type).toBe("interactive");
    expect(JSON.parse(String(send?.body.content))).toEqual({
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "# Report\n**done**" }] },
    });
  });

  it("rejects ambiguous input before network IO", async () => {
    const calls = stubOpenApi();
    await expect(fx.execute({ chatId: "oc_1", text: "x", markdown: "y" })).rejects.toThrow(/exactly one/);
    await expect(fx.execute({ chatId: "oc_1" })).rejects.toThrow(/exactly one/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a platform rejection as a named tool error", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).includes("tenant_access_token")
        ? Response.json({ code: 0, tenant_access_token: "T", expire: 7200 })
        : Response.json({ code: 230013, msg: "bot has no availability to this user" }),
    );
    await expect(fx.execute({ chatId: "oc_1", text: "hello" })).rejects.toThrow(/no availability/);
  });

  it("reuses the token and splits long text with the channel's byte limit", async () => {
    const calls = stubOpenApi();
    const text = "🙂".repeat(30_000);
    await fx.execute({ chatId: "oc_1", text });
    await fx.execute({ chatId: "oc_2", text: "next" });
    expect(calls.filter((call) => call.url.includes("tenant_access_token"))).toHaveLength(1);
    const chunks = calls
      .filter((call) => call.body.receive_id === "oc_1")
      .map((call) => JSON.parse(String(call.body.content)).text as string);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 100 * 1024)).toBe(true);
  });
});
