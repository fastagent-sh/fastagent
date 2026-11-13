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
import { feishuChannel } from "../../../src/feishu.ts";
import type { Needs } from "../../../src/harnesses/pi-durable/define.ts";
import { larkChannel } from "../../../src/lark.ts";

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

/** Every fixture's apps are numbered from one count, so no two tests of the file share an app. */
let apps = 0;

/** Loads one cloud's scaffold tool, built with app credentials, and gives every test a fresh state root. */
function cloudFixture(kind: "feishu" | "lark", prefix: "FEISHU" | "LARK") {
  const state = { declared: undefined as unknown as Needs<ToolRegistration>, cwd: "", appId: "" };
  beforeAll(async () => {
    // Scaffold files import the published package; Vitest aliases it to the current source.
    const path = new URL(`../../../src/channels/${kind}/scaffold/${kind}-send.ts`, import.meta.url).pathname;
    state.declared = ((await import(path)) as { default: Needs<ToolRegistration> }).default;
  });
  beforeEach(async () => {
    state.cwd = await mkdtemp(join(tmpdir(), `fa-${kind}-send-`));
    // A process keeps one transport per app: a fresh app per test, in any order, starts with no token cached.
    state.appId = `cli_env_${++apps}`;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await rm(state.cwd, { recursive: true, force: true });
  });
  const tool = (appId = state.appId) =>
    state.declared.build({ [`${prefix}_APP_ID`]: appId, [`${prefix}_APP_SECRET`]: "env-secret" }, {});
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
] as const)("scaffold $kind-send: the cloud it is bound to", ({ kind, prefix, base }) => {
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
});
