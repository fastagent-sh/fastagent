/**
 * The `{feishu,lark}-send` scaffold tool. The two files are the same tool bound to a different cloud,
 * so what differs per cloud (gateway, env prefix, credential isolation) runs for BOTH, and what does
 * not (the description contract, input validation, card/text encoding, transport reuse) runs once.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Agent, AgentEvent } from "../src/agent.ts";
import { turnContext } from "../src/engines/pi/tool-context.ts";
import { createPiAgentFromDefinition, type FastagentTool } from "../src/pi.ts";
import { feishuChannel } from "../src/feishu.ts";
import { larkChannel } from "../src/lark.ts";
import { makeFaux } from "./faux.ts";

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

const agent: Agent = {
  async *invoke() {
    yield { type: "completed" };
  },
};

/** Loads one cloud's scaffold tool and gives every test a fresh workspace + credential stubs. */
function cloudFixture(kind: "feishu" | "lark", prefix: "FEISHU" | "LARK") {
  const state = { tool: undefined as unknown as FastagentTool, cwd: "" };
  beforeAll(async () => {
    // Scaffold files import the published package; Vitest aliases it to the current source.
    const path = new URL(`../src/channels/${kind}/scaffold/${kind}-send.ts`, import.meta.url).pathname;
    state.tool = ((await import(path)) as { default: FastagentTool }).default;
  });
  beforeEach(async () => {
    state.cwd = await mkdtemp(join(tmpdir(), `fa-${kind}-send-`));
    await writeFile(join(state.cwd, "fastagent.config.mjs"), "export default {};\n");
    vi.stubEnv("FASTAGENT_STATE_DIR", "");
    vi.stubEnv("FASTAGENT_AGENT", "");
    vi.stubEnv(`${prefix}_APP_ID`, "");
    vi.stubEnv(`${prefix}_APP_SECRET`, "");
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await rm(state.cwd, { recursive: true, force: true });
  });
  return {
    get tool() {
      return state.tool;
    },
    get cwd() {
      return state.cwd;
    },
    execute: (params: unknown) => turnContext.run({ cwd: state.cwd }, () => state.tool.execute("call-1", params)),
    credentials: () => {
      vi.stubEnv(`${prefix}_APP_ID`, "cli_env");
      vi.stubEnv(`${prefix}_APP_SECRET`, "env-secret");
    },
  };
}

describe.each([
  { kind: "feishu", prefix: "FEISHU", base: "https://open.feishu.cn", channel: feishuChannel, other: larkChannel },
  { kind: "lark", prefix: "LARK", base: "https://open.larksuite.com", channel: larkChannel, other: feishuChannel },
] as const)("scaffold $kind-send: the cloud it is bound to", ({ kind, prefix, base, channel, other }) => {
  const fx = cloudFixture(kind, prefix);

  it("sends plain text through the correct cloud and env credentials", async () => {
    fx.credentials();
    const calls = stubOpenApi();
    expect((await fx.execute({ chatId: "oc_42", text: "digest ready" })).details).toBe("sent message to chat oc_42");
    expect(calls[0]?.body).toEqual({ app_id: "cli_env", app_secret: "env-secret" });
    expect(calls[1]).toEqual({
      url: `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      authorization: "Bearer cli_env",
      body: { receive_id: "oc_42", msg_type: "text", content: JSON.stringify({ text: "digest ready" }) },
    });
    expect(calls.every((call) => call.url.startsWith(`${base}/`))).toBe(true);
  });

  it("names its own env prefix when credentials are missing, before any network IO", async () => {
    const calls = stubOpenApi();
    await expect(fx.execute({ chatId: "oc_1", text: "x" })).rejects.toThrow(`${prefix}_APP_ID`);
    expect(calls).toHaveLength(0);
  });

  it("uses the mounted channel's credentials and gateway, keeping both clouds isolated", async () => {
    const calls = stubOpenApi();
    const ctx = { stateRoot: join(fx.cwd, ".state"), agent };
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
    await fx.execute({ chatId: "oc_1", text: "scheduled update" });
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
    expect(fx.tool.description).toMatch(/do not call this to answer/i);
    expect(fx.tool.description).toMatch(/post the message twice/i);
    expect(fx.tool.description).toMatch(/OUTSIDE the normal reply path/);
    expect(fx.tool.description).toMatch(/must come from your instructions/i);
    expect(fx.tool.description).toMatch(/only identifies the chat you are answering/i);
  });

  it.each([false, true])("sends from a config-free definition (independent cwd: %s)", async (independentCwd) => {
    const definitionDir = join(fx.cwd, "definition");
    const workspace = join(fx.cwd, "workspace");
    await mkdir(definitionDir);
    await mkdir(workspace);
    await writeFile(join(definitionDir, "persona.md"), "Send scheduled updates.\n");
    fx.credentials();
    const calls = stubOpenApi();
    const { faux } = makeFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("feishu-send", { chatId: "oc_embed", text: "embedded update" })),
      fauxAssistantMessage("sent"),
    ]);
    const { agent: embedded } = await createPiAgentFromDefinition(definitionDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      tools: [{ ...fx.tool, name: "feishu-send" }],
      ...(independentCwd ? { cwd: workspace } : {}),
    });
    const events: AgentEvent[] = [];
    for await (const event of embedded.invoke({ session: "embedded" }, { text: "Send the update." })) {
      events.push(event);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_ended", isError: false }));
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({
      url: "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      authorization: "Bearer cli_env",
      body: { receive_id: "oc_embed", content: JSON.stringify({ text: "embedded update" }) },
    });
  });

  it("sends Markdown as an inline static card", async () => {
    fx.credentials();
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
    fx.credentials();
    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).includes("tenant_access_token")
        ? Response.json({ code: 0, tenant_access_token: "T", expire: 7200 })
        : Response.json({ code: 230013, msg: "bot has no availability to this user" }),
    );
    await expect(fx.execute({ chatId: "oc_1", text: "hello" })).rejects.toThrow(/no availability/);
  });

  it("reuses the token and splits long text with the channel's byte limit", async () => {
    fx.credentials();
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
