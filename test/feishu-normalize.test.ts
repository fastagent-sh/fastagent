import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FeishuEventHeader, FeishuMessageEvent } from "../src/channels/feishu/model.ts";
import { decodeFeishuContent, normalizeFeishuMessage } from "../src/channels/feishu/normalize.ts";

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

describe("card (interactive) decoding — a card as the platform renders it down", () => {
  // What a read WITHOUT `user_card_content` returns for a card 1.0: `title` + `elements` paragraphs of
  // the same tagged nodes as `post`. This channel's reads ask for the card as sent (below); this shape
  // is still decoded wherever a card arrives rendered down.
  const card = {
    title: "需要先确认两项",
    elements: [
      [{ tag: "text", text: "确认后我会给出文件级方案；批准后再实现 SVG 足球页面。" }],
      [
        { tag: "a", href: "https://example.test/pr/1", text: "PR" },
        { tag: "img", image_key: "img_card_1" },
      ],
      [{ tag: "note", elements: [{ tag: "text", text: "备注" }] }],
    ],
  };

  it("reads a card's text instead of the bare type marker", () => {
    const decoded = decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(card) });

    expect(decoded.text).toContain("需要先确认两项"); // the title
    expect(decoded.text).toContain("SVG 足球页面"); // the ask, restated inside the agent's own answer
    expect(decoded.text).toContain("PR (https://example.test/pr/1)");
    expect(decoded.text).toContain("备注"); // `note` nests its own elements
    expect(decoded.text).not.toBe("[interactive message]");
  });

  it("collects NO resources from a card — the platform cannot serve them, so a key here would only fail", () => {
    // `im/v1/messages/:id/resources/:key` answers 234043 ("Unsupported message type") for a card
    // message id: a documented limitation, not a permission gap, so the download can never succeed.
    // A collected key becomes a PRIMARY turn input, and primary loads are fail-fast — so collecting
    // would turn a card that merely read as a marker into a turn that ERRORS OUT. Strictly worse than
    // the gap this branch closes.
    const decoded = decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(card) });

    expect(decoded.resources).toEqual([]);
    expect(decoded.text).toContain("[image]"); // the model still learns the image is there
  });

  it("still collects resources from a POST — the restriction is the card's, not the walker's", () => {
    // The same node walker backs both branches, so pinning this here keeps a future "just don't
    // collect" simplification from silently disarming rich-text attachments, which DO download.
    const post = {
      content: [[{ tag: "img", image_key: "img_post_1" }]],
    };
    expect(decodeFeishuContent({ message_type: "post", content: JSON.stringify(post) }).resources).toEqual([
      { kind: "image", key: "img_post_1" },
    ]);
  });

  it("accepts BOTH spellings — the platform's docs disagree with themselves (`interactive` vs `card`)", () => {
    // The field table says `interactive` (the receive event's spelling); the message-object example
    // says `"msg_type": "card"`. Matching one would leave the other on the default branch with exactly
    // the symptom this fixes, so the failure would look identical to no fix at all.
    const asCard = decodeFeishuContent({ message_type: "card", content: JSON.stringify(card) });
    expect(asCard.text).toContain("SVG 足球页面");
  });

  it("keeps the marker when a card renders to nothing — empty would read as a blank message", () => {
    const controlsOnly = { elements: [[{ tag: "button", type: "primary" }]] };
    expect(decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(controlsOnly) }).text).toBe(
      "[interactive message]",
    );
  });

  it("reads a widget's visible label, since a card is read for what it SAYS", () => {
    const labelled = {
      elements: [
        [
          { tag: "button", text: "批准" },
          { tag: "select_static", placeholder: "选一个" },
        ],
      ],
    };
    const decoded = decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(labelled) });
    expect(decoded.text).toContain("批准");
    expect(decoded.text).toContain("选一个");
  });
});

describe("card decoding — a card as it was SENT (`card_msg_content_type=user_card_content`)", () => {
  it("reads the agent's streamed answer, as the platform returned it for a real one", () => {
    // Verbatim from `GET /im/v1/messages/:id?card_msg_content_type=user_card_content` on a streamed answer card.
    const answer = {
      body: { elements: [{ content: "Hello! 👋 How can I help?", element_id: "answer", tag: "markdown" }] },
      config: {
        enable_forward_interaction: false,
        streaming_mode: false,
        summary: { content: "Hello! 👋 How can I help?" },
      },
      schema: "2.0",
    };
    expect(decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(answer) }).text).toBe(
      "Hello! 👋 How can I help?",
    );
  });

  it("reads a header title and text nested in containers, in reading order, with button labels", () => {
    const card = {
      schema: "2.0",
      header: { title: { tag: "plain_text", content: "Daily digest" } },
      body: {
        elements: [
          { tag: "markdown", content: "1. deploys" },
          {
            tag: "column_set",
            columns: [
              { tag: "column", elements: [{ tag: "div", text: { tag: "plain_text", content: "2. incidents" } }] },
            ],
          },
          { tag: "img", img_key: "img_1" },
          { tag: "button", text: { tag: "plain_text", content: "Open report" } },
        ],
      },
    };
    const decoded = decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(card) });
    expect(decoded.text).toBe("Daily digest\n1. deploys\n2. incidents\n[image]\nOpen report");
    expect(decoded.resources).toEqual([]); // a card's resources cannot be downloaded (see above)
  });

  it("reads a card 1.0 as it was sent: header title, div text, fields, notes and button labels", () => {
    // The 1.0 shape a CI or alert bot sends; with `user_card_content` a read returns it as sent, not rendered down.
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: "Build #42 failed" }, template: "red" },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "**main** · 3 tests failed" } },
        { tag: "div", fields: [{ is_short: true, text: { tag: "lark_md", content: "owner: alice" } }] },
        { tag: "hr" },
        { tag: "note", elements: [{ tag: "plain_text", content: "from ci-bot" }] },
        { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "Open logs" } }] },
      ],
    };
    expect(decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(card) }).text).toBe(
      "Build #42 failed\n**main** · 3 tests failed\nowner: alice\nfrom ci-bot\nOpen logs",
    );
  });

  it("recognizes a card 1.0 as sent by either half: a header with no elements, or elements with no header", () => {
    const decode = (card: unknown) =>
      decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(card) }).text;
    expect(decode({ header: { title: { tag: "plain_text", content: "Deploy approved" } } })).toBe("Deploy approved");
    expect(decode({ elements: [{ tag: "markdown", content: "disk at 91%" }] })).toBe("disk at 91%");
  });

  it("reads a multi-language card in its declared locale, title included", () => {
    const decode = (card: unknown) =>
      decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(card) }).text;
    const card10 = {
      config: { locales: ["en_us", "zh_cn"] },
      header: { title: { tag: "plain_text", i18n: { zh_cn: "构建失败", en_us: "Build failed" } } },
      i18n_elements: {
        zh_cn: [{ tag: "div", text: { tag: "lark_md", content: "3 个测试失败" } }],
        en_us: [{ tag: "div", text: { tag: "lark_md", content: "3 tests failed" } }],
      },
    };
    expect(decode(card10)).toBe("Build failed\n3 tests failed");
    // No declared locales: the first the card carries.
    expect(decode({ ...card10, config: {} })).toBe("构建失败\n3 个测试失败");
    // Per-locale elements alone mark a card as sent: no header needed.
    expect(decode({ i18n_elements: card10.i18n_elements })).toBe("3 个测试失败");
    // Card 2.0 spells a per-locale text `i18n_content`, with no per-locale element lists: the declared order still
    // decides, whatever order the JSON lists the locales in.
    const card20 = {
      schema: "2.0",
      config: { locales: ["en_us", "zh_cn"] },
      header: { title: { tag: "plain_text", i18n_content: { zh_cn: "告警", en_us: "Alert" } } },
      body: { elements: [{ tag: "markdown", i18n_content: { zh_cn: "磁盘 91%", en_us: "disk at 91%" } }] },
    };
    expect(decode(card20)).toBe("Alert\ndisk at 91%");
  });

  it("reads a collapsible panel's title, the one line it shows folded, before its content", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          {
            tag: "collapsible_panel",
            header: { title: { tag: "markdown", content: "Details" } },
            elements: [{ tag: "markdown", content: "inner" }],
          },
        ],
      },
    };
    expect(decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(card) }).text).toBe(
      "Details\ninner",
    );
  });

  it("says a template card cannot be read, rather than leaving a bare marker", () => {
    const template = { type: "template", data: { template_id: "ctp_1", template_variable: { build: "42" } } };
    expect(decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(template) }).text).toBe(
      "[interactive message: a template card; its text cannot be read]",
    );
  });

  it("keeps the marker when a Card 2.0 renders to nothing", () => {
    const controlsOnly = { schema: "2.0", body: { elements: [{ tag: "button" }] } };
    expect(decodeFeishuContent({ message_type: "interactive", content: JSON.stringify(controlsOnly) }).text).toBe(
      "[interactive message]",
    );
  });
});
