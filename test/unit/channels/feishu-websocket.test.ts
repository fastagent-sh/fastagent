import { mkdtemp, readFile } from "node:fs/promises";
import { scriptedAgent } from "../../doubles/scripted-agent.ts";
import { ev } from "../../doubles/scripted-run.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { channelContext } from "../../../packages/fastagent/src/channels/context.ts";
import { feishuWebSocket } from "../../../packages/fastagent/src/channels/feishu/feishu.ts";
import type { FeishuMessageEvent } from "../../../packages/fastagent/src/channels/feishu/parse.ts";

const event = {
  sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
  message: {
    message_id: "om_ws",
    chat_id: "oc_ws",
    chat_type: "p2p",
    message_type: "text",
    content: JSON.stringify({ text: "hello" }),
  },
} as FeishuMessageEvent;

describe("Feishu/Lark WebSocket ingress", () => {
  it("takes an event over the WebSocket, on either domain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("tenant_access_token")) {
          return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
        }
        if (url.includes("/bot/v3/info")) {
          return Response.json({ code: 0, msg: "ok", bot: { open_id: "ou_bot" } });
        }
        if (url.endsWith("/cardkit/v1/cards")) {
          return Response.json({ code: 0, msg: "ok", data: { card_id: "card_ws" } });
        }
        if (url.includes("/im/v1/messages")) {
          return Response.json({ code: 0, msg: "ok", data: { message_id: "om_reply" } });
        }
        return Response.json({ code: 0, msg: "ok", data: {} });
      }),
    );
    for (const domain of ["feishu", "lark"] as const) {
      const root = await mkdtemp(join(tmpdir(), `fastagent-${domain}-ws-`));
      let accepted: ((event: FeishuMessageEvent) => void | Promise<void>) | undefined;
      const channel = feishuWebSocket(
        { domain, appId: "cli_0123456789abcdef", appSecret: "secret" },
        {
          connectWs(options) {
            accepted = options.onEvent;
            return { ready: Promise.resolve(), closed: new Promise<void>(() => {}) };
          },
        },
      );
      const agent = scriptedAgent(async function* (_request) {
        yield ev.message();
        yield ev.ended();
      });
      const run = channel.connect(channelContext(agent, root, domain), new AbortController().signal);
      await run.ready;
      expect(accepted).toBeTypeOf("function");
      await accepted?.(event);
      expect(await readFile(join(root, "channels", domain, "seen.json"), "utf8")).toContain("om_ws");
    }
  });
});
