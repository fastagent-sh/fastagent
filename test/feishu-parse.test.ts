import { describe, expect, it } from "vitest";
import {
  type FeishuMessage,
  type FeishuMessageEvent,
  defaultFeishuRoute,
  feishuEnvelope,
  mentionsBot,
  parseContent,
  placeKey,
  senderLabel,
} from "../src/channels/feishu/parse.ts";

const msg = (over: Partial<FeishuMessage> = {}): FeishuMessage => ({
  message_id: "om_1",
  chat_id: "oc_1",
  chat_type: "group",
  message_type: "text",
  content: JSON.stringify({ text: "hello" }),
  ...over,
});

const event = (
  m: Partial<FeishuMessage> = {},
  sender: FeishuMessageEvent["sender"] = { sender_type: "user", sender_id: { open_id: "ou_alice" } },
): FeishuMessageEvent => ({
  sender,
  message: msg(m),
});

describe("parseContent", () => {
  it("text: restores EVERY mention placeholder to the mention's name", () => {
    const parsed = parseContent(
      msg({
        content: JSON.stringify({ text: "@_user_1 look at this, @_user_1 — and @_user_2 too" }),
        mentions: [
          { key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } },
          { key: "@_user_2", name: "Bob", id: { open_id: "ou_bob" } },
        ],
      }),
    );
    expect(parsed.text).toBe("@Bot look at this, @Bot — and @Bob too");
    expect(parsed.imageKeys).toEqual([]);
    expect(parsed.fileRefs).toEqual([]);
  });

  it("post: renders title + paragraphs, inlines at/a/code_block, and collects img/media resources", () => {
    const parsed = parseContent(
      msg({
        message_type: "post",
        content: JSON.stringify({
          title: "Weekly",
          content: [
            [
              { tag: "at", user_name: "Bot", user_id: "ou_bot" },
              { tag: "text", text: " please review " },
              { tag: "a", text: "the doc", href: "https://x.test/d" },
            ],
            [{ tag: "img", image_key: "img_k1" }],
            [{ tag: "media", file_key: "file_k1", file_name: "demo.mp4" }],
            [{ tag: "code_block", language: "PYTHON", text: "print(1)" }],
          ],
        }),
      }),
    );
    expect(parsed.text).toContain("Weekly");
    expect(parsed.text).toContain("@Bot please review the doc (https://x.test/d)");
    expect(parsed.text).toContain("[image]");
    expect(parsed.text).toContain("[video]");
    expect(parsed.text).toContain("```python\nprint(1)\n```");
    expect(parsed.imageKeys).toEqual(["img_k1"]);
    expect(parsed.fileRefs).toEqual([{ key: "file_k1", name: "demo.mp4" }]);
  });

  it("image / file / audio / media / location decode to markers + resource refs", () => {
    expect(parseContent(msg({ message_type: "image", content: '{"image_key":"k1"}' }))).toEqual({
      text: "[image]",
      imageKeys: ["k1"],
      fileRefs: [],
    });
    expect(parseContent(msg({ message_type: "file", content: '{"file_key":"k2","file_name":"a.pdf"}' }))).toEqual({
      text: "[file: a.pdf]",
      imageKeys: [],
      fileRefs: [{ key: "k2", name: "a.pdf" }],
    });
    expect(parseContent(msg({ message_type: "audio", content: '{"file_key":"k3"}' })).fileRefs).toEqual([
      { key: "k3", name: "voice-message" },
    ]);
    expect(parseContent(msg({ message_type: "media", content: '{"file_key":"k4","file_name":"v.mp4"}' })).text).toBe(
      "[video: v.mp4]",
    );
    expect(
      parseContent(msg({ message_type: "location", content: '{"name":"HQ","latitude":"31.2","longitude":"121.5"}' }))
        .text,
    ).toBe("[location: HQ — 31.2,121.5]");
  });

  it("an unknown type and malformed content degrade to visible markers, never a throw", () => {
    expect(parseContent(msg({ message_type: "sticker", content: '{"file_key":"s"}' })).text).toBe("[sticker message]");
    expect(parseContent(msg({ content: "not json" })).text).toBe("[unreadable text message]");
  });
});

describe("summon + route policy", () => {
  it("mentionsBot matches on the bot's open_id, and fails CLOSED without an identity", () => {
    const m = msg({ mentions: [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }] });
    expect(mentionsBot(m, "ou_bot")).toBe(true);
    expect(mentionsBot(m, "ou_other")).toBe(false);
    expect(mentionsBot(m, undefined)).toBe(false); // no identity → never summon
    expect(mentionsBot(msg(), "ou_bot")).toBe(false); // no mentions array
  });

  it("defaultFeishuRoute: p2p answers; a group only on an @mention of THIS bot", () => {
    expect(defaultFeishuRoute(event({ chat_type: "p2p" }), { botOpenId: "ou_bot" })).toEqual({});
    expect(defaultFeishuRoute(event({ chat_type: "group" }), { botOpenId: "ou_bot" })).toBeNull();
    expect(
      defaultFeishuRoute(event({ chat_type: "group", mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] }), {
        botOpenId: "ou_bot",
      }),
    ).toEqual({});
  });

  it("defaultFeishuRoute ignores non-user senders (bot↔bot loops) and empty events — fail closed", () => {
    expect(defaultFeishuRoute(event({ chat_type: "p2p" }, { sender_type: "app" }), { botOpenId: "b" })).toBeNull();
    expect(defaultFeishuRoute({ message: msg({ chat_type: "p2p" }) }, { botOpenId: "b" })).toBeNull(); // no sender
    expect(defaultFeishuRoute({ sender: { sender_type: "user" } }, { botOpenId: "b" })).toBeNull(); // no message
  });
});

describe("envelope + keys", () => {
  it("placeKey: chat, or chat:topic in a topic group", () => {
    expect(placeKey(msg())).toBe("oc_1");
    expect(placeKey(msg({ thread_id: "omt_9" }))).toBe("oc_1:omt_9");
  });

  it("senderLabel prefers open_id and degrades through the id tiers", () => {
    expect(senderLabel({ sender_id: { open_id: "ou_1" } })).toBe("user ou_1");
    expect(senderLabel({ sender_id: { user_id: "u1" } })).toBe("user u1");
    expect(senderLabel(undefined)).toBeUndefined();
  });

  it("feishuEnvelope carries meta, the group note, the reply marker, and the decoded body", () => {
    const e = event({ parent_id: "om_prev", thread_id: "omt_2", content: '{"text":"summarize"}' });
    const env = feishuEnvelope(e);
    expect(env).toContain("[feishu: chat oc_1 (group), topic omt_2, from user ou_alice]");
    expect(env).toContain("[group chat — multiple people; each message is prefixed with its sender]");
    expect(env).toContain("[in reply to msg om_prev]");
    expect(env).toContain("summarize");
    // p2p: no group note
    expect(feishuEnvelope(event({ chat_type: "p2p" }))).not.toContain("group chat —");
  });
});
