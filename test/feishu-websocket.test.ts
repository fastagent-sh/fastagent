import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent.ts";
import { FEISHU_CLOUD, LARK_COMPAT_CLOUD } from "../src/channels/feishu/cloud.ts";
import { buildFeishuWebSocketChannel, feishuChannel, feishuWebSocketChannel } from "../src/channels/feishu/feishu.ts";
import { larkChannel, larkWebSocketChannel } from "../src/channels/lark/lark.ts";
import type { FeishuMessageEvent } from "../src/channels/feishu/parse.ts";
import { type CreateFeishuWsClient, connectFeishuWs } from "../src/channels/feishu/ws-ingress.ts";

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
  it("keeps webhook and WebSocket factories structurally distinct", () => {
    const credentials = { appId: "cli_0123456789abcdef", appSecret: "secret" };
    expect(feishuChannel({ ...credentials, verificationToken: "token" })).toBeTypeOf("function");
    expect(larkChannel({ ...credentials, verificationToken: "token" })).toBeTypeOf("function");
    expect(feishuWebSocketChannel(credentials)).toMatchObject({ name: "feishu websocket" });
    expect(larkWebSocketChannel(credentials)).toMatchObject({ name: "lark websocket" });
  });

  it("exposes a long-connection module for both cloud profiles", async () => {
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
    for (const profile of [FEISHU_CLOUD, LARK_COMPAT_CLOUD]) {
      const root = await mkdtemp(join(tmpdir(), `fastagent-${profile.kind}-ws-`));
      let accepted: ((event: FeishuMessageEvent) => void | Promise<void>) | undefined;
      const module = buildFeishuWebSocketChannel(
        profile,
        { appId: "cli_0123456789abcdef", appSecret: "secret" },
        `${profile.kind}Channel`,
        {
          connectWs(options) {
            accepted = options.onEvent;
            return { ready: Promise.resolve(), closed: new Promise<void>(() => {}) };
          },
        },
      );
      const agent: Agent = {
        async *invoke() {
          yield { type: "completed" };
        },
      };
      const run = module.connect({ agent, stateRoot: root }, new AbortController().signal);
      await run.ready;
      expect(accepted).toBeTypeOf("function");
      await accepted?.(event);
      expect(await readFile(join(root, "channels", profile.kind, "seen.json"), "utf8")).toContain("om_ws");
    }
  });

  it("propagates a pre-ACK persistence failure through the real SDK EventDispatcher", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes("tenant_access_token")
          ? Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 })
          : Response.json({ code: 0, msg: "ok", bot: { open_id: "ou_bot" } }),
      ),
    );
    const root = await mkdtemp(join(tmpdir(), "fastagent-feishu-ws-write-failure-"));
    let accepted: ((event: FeishuMessageEvent) => void | Promise<void>) | undefined;
    const module = buildFeishuWebSocketChannel(
      FEISHU_CLOUD,
      { appId: "cli_0123456789abcdef", appSecret: "secret" },
      "feishuWebSocketChannel",
      {
        connectWs(options) {
          accepted = options.onEvent;
          return { ready: Promise.resolve(), closed: new Promise<void>(() => {}) };
        },
      },
    );
    const agent: Agent = {
      async *invoke() {
        yield { type: "completed" };
      },
    };
    module.connect({ agent, stateRoot: root }, new AbortController().signal);
    const home = join(root, "channels", "feishu");
    await mkdir(join(home, "turns.json.tmp")); // saveStateFile(writeFile) fails with EISDIR before the ACK

    const { EventDispatcher, LoggerLevel } = await import("@larksuiteoapi/node-sdk");
    const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({
      "im.message.receive_v1": accepted!,
    });
    await expect(
      dispatcher.invoke(
        { schema: "2.0", header: { event_type: "im.message.receive_v1" }, event },
        { needCheck: false },
      ),
    ).rejects.toThrow();
    await expect(readFile(join(home, "turns.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, "seen.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(join(home, "buffers.json.tmp"));
    const groupEvent = {
      ...event,
      message: { ...event.message, message_id: "om_ws_group", chat_type: "group" },
    } as FeishuMessageEvent;
    await expect(
      dispatcher.invoke(
        { schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: groupEvent },
        { needCheck: false },
      ),
    ).rejects.toThrow();
    await expect(readFile(join(home, "buffers.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, "seen.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps SDK readiness, reconnect callbacks, events, fatal errors, and abort into long-connection lifecycle", async () => {
    let callbacks: Parameters<CreateFeishuWsClient>[0] | undefined;
    let closed = false;
    const received: FeishuMessageEvent[] = [];
    const abort = new AbortController();
    const run = connectFeishuWs(
      {
        kind: "feishu",
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
        domain: "https://open.feishu.cn",
        onEvent(incoming) {
          received.push(incoming);
        },
        createClient(next) {
          callbacks = next;
          return {
            async start() {},
            close() {
              closed = true;
            },
          };
        },
      },
      abort.signal,
    );
    expect(run).not.toHaveProperty("close");
    callbacks?.onReady();
    await run.ready;
    await callbacks?.onEvent(event);
    expect(received).toEqual([event]);
    callbacks?.onReconnecting();
    callbacks?.onReconnected();
    abort.abort();
    await run.closed;
    expect(closed).toBe(true);

    let failingCallbacks: Parameters<CreateFeishuWsClient>[0] | undefined;
    let failedClientClosed = false;
    const failed = connectFeishuWs(
      {
        kind: "lark",
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
        domain: "https://open.larksuite.com",
        onEvent() {},
        createClient(next) {
          failingCallbacks = next;
          return {
            async start() {},
            close() {
              failedClientClosed = true;
            },
          };
        },
      },
      new AbortController().signal,
    );
    // createClient resolves on the microtask queue; the client must exist before the terminal error.
    await Promise.resolve();
    failingCallbacks?.onError(new Error("credentials rejected"));
    await expect(failed.ready).rejects.toThrow(/credentials rejected/);
    await expect(failed.closed).rejects.toThrow(/credentials rejected/);
    // Terminal failure releases the transport: abort can no longer close (closedSettled), so fail() must.
    expect(failedClientClosed).toBe(true);
  });
});
