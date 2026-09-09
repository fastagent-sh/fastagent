import { describe, expect, it, vi } from "vitest";
import { normalizeSlackEmojiName, resolveReactionEmojis, startSlackReaction } from "../src/channels/slack/reaction.ts";

describe("normalizeSlackEmojiName", () => {
  it("accepts plain, colon-wrapped and skin-tone names; rejects invalid or empty ones", () => {
    expect(normalizeSlackEmojiName("eyes")).toBe("eyes");
    expect(normalizeSlackEmojiName(":white_check_mark:")).toBe("white_check_mark");
    expect(normalizeSlackEmojiName("+1::skin-tone-3")).toBe("+1::skin-tone-3");
    expect(normalizeSlackEmojiName("not valid!")).toBeNull();
    expect(normalizeSlackEmojiName("   ")).toBeNull();
  });
});

describe("resolveReactionEmojis", () => {
  it("returns defaults, honors overrides, disables with false, and throws on an invalid name", () => {
    expect(resolveReactionEmojis({})).toEqual({ processing: "eyes", completed: "white_check_mark" });
    expect(resolveReactionEmojis({ processing: ":hourglass:" })).toEqual({
      processing: "hourglass",
      completed: "white_check_mark",
    });
    expect(resolveReactionEmojis(false)).toBeUndefined();
    expect(() => resolveReactionEmojis({ completed: "bad emoji!" })).toThrow(/reactionAck/);
  });
});

describe("startSlackReaction", () => {
  const fakeApi = () => ({ addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}) });
  const emojis = { processing: "eyes", completed: "white_check_mark" };

  it("adds the processing emoji, then swaps to completed on complete()", async () => {
    const api = fakeApi();
    const session = await startSlackReaction({ api, channelId: "D1", ts: "1.0", emojis, label: "[t]" });
    expect(api.addReaction).toHaveBeenCalledWith("D1", "1.0", "eyes");
    await session.complete();
    expect(api.removeReaction).toHaveBeenCalledWith("D1", "1.0", "eyes");
    expect(api.addReaction).toHaveBeenCalledWith("D1", "1.0", "white_check_mark");
  });

  it("only removes the processing emoji on remove(), idempotently", async () => {
    const api = fakeApi();
    const session = await startSlackReaction({ api, channelId: "D1", ts: "1.0", emojis, label: "[t]" });
    await session.remove();
    await session.remove();
    expect(api.removeReaction).toHaveBeenCalledTimes(1);
    expect(api.addReaction).toHaveBeenCalledTimes(1);
  });

  it("degrades to a no-op session when the initial add fails", async () => {
    const api = fakeApi();
    api.addReaction.mockRejectedValueOnce(new Error("missing_scope"));
    const session = await startSlackReaction({ api, channelId: "D1", ts: "1.0", emojis, label: "[t]" });
    await session.complete();
    expect(api.removeReaction).not.toHaveBeenCalled();
    expect(api.addReaction).toHaveBeenCalledTimes(1);
  });
});
