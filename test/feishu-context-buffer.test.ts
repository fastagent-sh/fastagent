import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectFeishuBufferedAttachments,
  createFeishuContextBuffer,
  feishuBufferPlaceKey,
} from "../src/channels/feishu/context-buffer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "feishu-buffer-"));
  roots.push(root);
  return join(root, "buffers.json");
}

describe("Feishu/Lark group context buffer", () => {
  it("isolates main chat and thread roots, persists, and commits only the peeked snapshot", () => {
    const path = statePath();
    const buffer = createFeishuContextBuffer(path, "[feishu]");
    const chat = feishuBufferPlaceKey({ chatId: "oc_1" });
    const topic = feishuBufferPlaceKey({ chatId: "oc_1", rootId: "om_root", threadId: "omt_1" });

    buffer.push(chat, { sender: "user alice", body: "main context", messageId: "om_1" });
    buffer.push(topic, { sender: "user bob", body: "thread context", messageId: "om_2" });

    const restarted = createFeishuContextBuffer(path, "[feishu]");
    const snapshot = restarted.peek(topic);
    restarted.push(topic, { sender: "user carol", body: "arrived during turn", messageId: "om_3" });
    restarted.commit(topic, snapshot.consumed);

    expect(restarted.peek(chat).text).toContain("main context");
    expect(restarted.peek(topic).text).not.toContain("thread context");
    expect(restarted.peek(topic).text).toContain("arrived during turn");
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("oc_1");
  });

  it("deduplicates message-scoped resources, excludes primary input, and caps to the newest few", () => {
    const consumed = Array.from({ length: 5 }, (_, index) => ({
      sender: `user ${index}`,
      body: `file ${index}`,
      messageId: `om_${index}`,
      files: [{ messageId: `om_${index}`, key: `file_${index}`, name: `${index}.txt` }],
      images: [{ messageId: `om_${index}`, key: `image_${index}` }],
    }));
    // A repeated message-scoped ref is one resource, while the same bare key in another message would
    // remain distinct. The current turn's own resource is never downloaded again from the buffer.
    consumed.push({
      sender: "user repeat",
      body: "repeat",
      messageId: "om_repeat",
      files: [{ messageId: "om_4", key: "file_4", name: "4.txt" }],
      images: [],
    });

    const selected = collectFeishuBufferedAttachments(consumed, {
      files: [{ messageId: "om_3", key: "file_3" }],
      images: [],
    });

    expect(selected.files.map((ref) => ref.key)).toEqual(["file_1", "file_2", "file_4"]);
    expect(selected.images.map((ref) => ref.key)).toEqual(["image_2", "image_3", "image_4"]);
    expect(selected.skipped).toBe(3);
  });
});
