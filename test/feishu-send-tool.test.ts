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

describe.each([
  { kind: "feishu", prefix: "FEISHU", base: "https://open.feishu.cn", channel: feishuChannel, other: larkChannel },
  { kind: "lark", prefix: "LARK", base: "https://open.larksuite.com", channel: larkChannel, other: feishuChannel },
])("scaffold $kind-send", ({ kind, prefix, base, channel, other }) => {
  let tool: FastagentTool;
  let cwd: string;
  beforeAll(async () => {
    // Scaffold files import the published package; Vitest aliases it to the current source.
    const path = new URL(`../src/channels/${kind}/scaffold/${kind}-send.ts`, import.meta.url).pathname;
    tool = ((await import(path)) as { default: FastagentTool }).default;
  });
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), `fa-${kind}-send-`));
    await writeFile(join(cwd, "fastagent.config.mjs"), "export default {};\n");
    vi.stubEnv("FASTAGENT_STATE_DIR", "");
    vi.stubEnv("FASTAGENT_AGENT", "");
    vi.stubEnv(`${prefix}_APP_ID`, "");
    vi.stubEnv(`${prefix}_APP_SECRET`, "");
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await rm(cwd, { recursive: true, force: true });
  });
  const execute = (params: unknown) => turnContext.run({ cwd }, () => tool.execute("call-1", params));
  const credentials = () => {
    vi.stubEnv(`${prefix}_APP_ID`, "cli_env");
    vi.stubEnv(`${prefix}_APP_SECRET`, "env-secret");
  };

  it("states the destination rule and avoids duplicating a normal chat reply", () => {
    expect(tool.description).toMatch(/do not call this to answer/i);
    expect(tool.description).toMatch(/post the message twice/i);
    expect(tool.description).toMatch(/OUTSIDE the normal reply path/);
    expect(tool.description).toMatch(/must come from your instructions/i);
    expect(tool.description).toMatch(/only identifies the chat you are answering/i);
  });

  it("sends plain text through the correct cloud and env credentials", async () => {
    credentials();
    const calls = stubOpenApi();
    expect((await execute({ chatId: "oc_42", text: "digest ready" })).details).toBe("sent message to chat oc_42");
    expect(calls[0]?.body).toEqual({ app_id: "cli_env", app_secret: "env-secret" });
    expect(calls[1]).toEqual({
      url: `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      authorization: "Bearer cli_env",
      body: { receive_id: "oc_42", msg_type: "text", content: JSON.stringify({ text: "digest ready" }) },
    });
    expect(calls.every((call) => call.url.startsWith(`${base}/`))).toBe(true);
  });

  it.each([false, true])("sends from a config-free definition (independent cwd: %s)", async (independentCwd) => {
    const definitionDir = join(cwd, "definition");
    const workspace = join(cwd, "workspace");
    await mkdir(definitionDir);
    await mkdir(workspace);
    await writeFile(join(definitionDir, "persona.md"), "Send scheduled updates.\n");
    credentials();
    const calls = stubOpenApi();
    const name = `${kind}-send`;
    const { faux } = makeFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, { chatId: "oc_embed", text: "embedded update" })),
      fauxAssistantMessage("sent"),
    ]);
    const { agent: embedded } = await createPiAgentFromDefinition(definitionDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      tools: [{ ...tool, name }],
      ...(independentCwd ? { cwd: workspace } : {}),
    });
    const events: AgentEvent[] = [];
    for await (const event of embedded.invoke({ session: "embedded" }, { text: "Send the update." })) {
      events.push(event);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_ended", isError: false }));
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({
      url: `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      authorization: "Bearer cli_env",
      body: { receive_id: "oc_embed", content: JSON.stringify({ text: "embedded update" }) },
    });
  });

  it("sends Markdown as an inline static card", async () => {
    credentials();
    const calls = stubOpenApi();
    expect((await execute({ chatId: "oc_7", markdown: "# Report\n**done**" })).details).toBe("sent card to chat oc_7");
    const send = calls[1];
    expect(send?.body.msg_type).toBe("interactive");
    expect(JSON.parse(String(send?.body.content))).toEqual({
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "# Report\n**done**" }] },
    });
  });

  it("rejects ambiguous input and missing credentials before network IO", async () => {
    const calls = stubOpenApi();
    await expect(execute({ chatId: "oc_1", text: "x", markdown: "y" })).rejects.toThrow(/exactly one/);
    await expect(execute({ chatId: "oc_1" })).rejects.toThrow(/exactly one/);
    await expect(execute({ chatId: "oc_1", text: "x" })).rejects.toThrow(`${prefix}_APP_ID`);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a platform rejection as a named tool error", async () => {
    credentials();
    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).includes("tenant_access_token")
        ? Response.json({ code: 0, tenant_access_token: "T", expire: 7200 })
        : Response.json({ code: 230013, msg: "bot has no availability to this user" }),
    );
    await expect(execute({ chatId: "oc_1", text: "hello" })).rejects.toThrow(/no availability/);
  });

  it("reuses the token and splits long text with the channel's byte limit", async () => {
    credentials();
    const calls = stubOpenApi();
    const text = "🙂".repeat(30_000);
    await execute({ chatId: "oc_1", text });
    await execute({ chatId: "oc_2", text: "next" });
    expect(calls.filter((call) => call.url.includes("tenant_access_token"))).toHaveLength(1);
    const chunks = calls
      .filter((call) => call.body.receive_id === "oc_1")
      .map((call) => JSON.parse(String(call.body.content)).text as string);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 100 * 1024)).toBe(true);
  });

  it("uses the mounted channel's credentials and gateway, keeping both clouds isolated", async () => {
    const calls = stubOpenApi();
    const ctx = { stateRoot: join(cwd, ".state"), agent };
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
    await execute({ chatId: "oc_1", text: "scheduled update" });
    expect(calls.at(-1)).toMatchObject({
      url: `https://${kind}.test/open-apis/im/v1/messages?receive_id_type=chat_id`,
      authorization: "Bearer cli_channel",
    });
  });
});
