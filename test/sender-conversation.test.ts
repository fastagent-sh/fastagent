import { describe, expect, it } from "vitest";
import { isSenderConversation, senderConversation } from "../src/channels/kit/sender-conversation.ts";

describe("a group's main timeline, one conversation per sender", () => {
  it("keys a sender apart from the place and from every other sender", () => {
    expect(senderConversation("-100", 7)).toBe("-100#7");
    expect(senderConversation("-100", 7)).not.toBe(senderConversation("-100", 8));
    expect(senderConversation("feishu:oc_1", "ou_alice")).toBe("feishu:oc_1#ou_alice");
    expect(senderConversation("-100", 7)).not.toBe("-100"); // never the key of the place itself
  });

  it("keeps a thread's or topic's key out of reach of a sender's: a place never contains the separator", () => {
    expect(senderConversation("-100:7", 5)).toBe("-100:7#5");
    expect(isSenderConversation("-100", "-100:7")).toBe(false);
    expect(isSenderConversation("-100", "-100#7")).toBe(true);
  });

  it("falls back to the place's one conversation for a sender the platform gave no id", () => {
    expect(senderConversation("-100", undefined)).toBe("-100");
    expect(senderConversation("-100", "")).toBe("-100");
    expect(isSenderConversation("-100", senderConversation("-100", undefined))).toBe(false);
  });
});
