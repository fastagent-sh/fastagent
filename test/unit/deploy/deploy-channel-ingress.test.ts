import { describe, expect, it, vi } from "vitest";
import { declaredChannels } from "../../../src/channels/discover.ts";
import type { RegistrationOutcome } from "../../../src/channels/registration.ts";
import { pointChannelsAt } from "../../../src/deploy/channel-ingress.ts";

const registered = (): Promise<RegistrationOutcome> => Promise.resolve("registered");
const webhook = (...names: string[]) => declaredChannels(names);
const longConnection = (...names: string[]) => declaredChannels(names, "long-connection");

describe("deploy/channel-ingress: which channels have a webhook", () => {
  it("does not register a long-connection channel — the connection IS the ingress", async () => {
    const telegram = vi.fn(registered);
    const outcomes = await pointChannelsAt({
      baseUrl: "https://x",
      channels: longConnection("telegram"),
      registrars: { telegram },
      log: () => {},
    });
    expect(telegram).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it("each kind reaches its own registrar, and one only a person can set is manual", async () => {
    const feishu = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const outcomes = await pointChannelsAt({
      baseUrl: "https://x",
      channels: webhook("telegram", "slack", "feishu", "lark"),
      registrars: { telegram: async () => "failed", feishu },
      log: () => {},
    });
    expect(feishu.mock.calls).toEqual([
      ["https://x", "feishu"],
      ["https://x", "lark"],
    ]);
    expect(outcomes).toEqual([
      { kind: "telegram", outcome: "failed" },
      { kind: "slack", outcome: "manual" },
      { kind: "feishu", outcome: "registered" },
      { kind: "lark", outcome: "registered" },
    ]);
  });
});
