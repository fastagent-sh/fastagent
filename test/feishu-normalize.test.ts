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
  it("normalizes the conversation place and decoded content the turn wiring consumes", () => {
    const raw = fixture("feishu");
    const message = normalizeFeishuMessage(raw.event);

    expect(raw.schema).toBe("2.0");
    expect(message).toEqual({
      conversation: {
        chatId: "oc_feishu_chat",
        threadId: "omt_feishu_topic",
      },
      content: {
        text: "@FastAgent review this",
        hasMentions: true,
        resources: [],
      },
    });
  });

  it("normalizes the same Lark wire model and scopes every resource to its carrying message", () => {
    const raw = fixture("lark");
    const message = normalizeFeishuMessage(raw.event);

    expect(raw.header.event_type).toBe("im.message.receive_v1");
    expect(message?.conversation).toEqual({
      chatId: "oc_lark_chat",
      threadId: undefined,
    });
    expect(message?.content.text).toContain("Project update");
    expect(message?.content.text).toContain("the spec (https://example.test/spec)");
    expect(message?.content.hasMentions).toBe(false);
    expect(message?.content.resources).toEqual([
      { kind: "image", key: "img_lark_1", messageId: "om_lark_message_1" },
      { kind: "video", key: "file_lark_1", name: "demo.mp4", messageId: "om_lark_message_1" },
    ]);
  });

  it("rejects an event without a message identity at the normalization boundary", () => {
    expect(normalizeFeishuMessage({ sender: { sender_type: "user" } })).toBeNull();
  });
});
