import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FeishuEventHeader, FeishuMessageEvent } from "../src/channels/feishu/model.ts";
import { normalizeFeishuMessage } from "../src/channels/feishu/normalize.ts";

interface MessageFixture {
  schema: string;
  header: FeishuEventHeader;
  event: FeishuMessageEvent;
}

function fixture(kind: "feishu" | "lark"): MessageFixture {
  const url = new URL(`./fixtures/${kind}/message.receive_v1.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as MessageFixture;
}

describe("Feishu/Lark normalized webhook model", () => {
  it("normalizes the canonical Feishu envelope without losing identity or conversation relations", () => {
    const raw = fixture("feishu");
    const message = normalizeFeishuMessage(raw.event, {
      cloud: "feishu",
      header: raw.header,
      botOpenId: "ou_bot",
    });

    expect(raw.schema).toBe("2.0");
    expect(message).toEqual({
      source: {
        cloud: "feishu",
        appId: "cli_feishu_fixture",
        tenantKey: "tenant_feishu_fixture",
      },
      delivery: {
        eventId: "ev_feishu_message_1",
        messageId: "om_feishu_message_1",
        eventCreatedAt: 1710000000123,
        messageCreatedAt: 1710000000000,
      },
      conversation: {
        chatId: "oc_feishu_chat",
        chatType: "group",
        threadId: "omt_feishu_topic",
        rootId: "om_topic_root",
        parentId: "om_parent",
      },
      sender: {
        type: "user",
        openId: "ou_alice",
        userId: "u_alice",
        unionId: "on_alice",
        tenantKey: "tenant_feishu_fixture",
      },
      content: {
        rawType: "text",
        text: "@FastAgent review this",
        mentions: [
          {
            key: "@_user_1",
            openId: "ou_bot",
            userId: undefined,
            unionId: undefined,
            name: "FastAgent",
            isBot: true,
          },
        ],
        resources: [],
      },
    });
  });

  it("normalizes the same Lark wire model and scopes every resource to its carrying message", () => {
    const raw = fixture("lark");
    const message = normalizeFeishuMessage(raw.event, { cloud: "lark", header: raw.header });

    expect(raw.header.event_type).toBe("im.message.receive_v1");
    expect(message?.source).toEqual({
      cloud: "lark",
      appId: "cli_lark_fixture",
      tenantKey: "tenant_lark_fixture",
    });
    expect(message?.conversation).toEqual({
      chatId: "oc_lark_chat",
      chatType: "p2p",
      threadId: undefined,
      rootId: undefined,
      parentId: undefined,
    });
    expect(message?.content.text).toContain("Project update");
    expect(message?.content.text).toContain("the spec (https://example.test/spec)");
    expect(message?.content.resources).toEqual([
      { kind: "image", key: "img_lark_1", messageId: "om_lark_message_1" },
      { kind: "video", key: "file_lark_1", name: "demo.mp4", messageId: "om_lark_message_1" },
    ]);
  });

  it("rejects an event without a message identity at the normalization boundary", () => {
    expect(normalizeFeishuMessage({ sender: { sender_type: "user" } }, { cloud: "feishu" })).toBeNull();
  });
});
