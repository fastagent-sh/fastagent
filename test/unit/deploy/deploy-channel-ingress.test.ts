import { describe, expect, it, vi } from "vitest";
import { declaredChannels } from "../../../src/channels/discover.ts";
import type { RegistrationOutcome } from "../../../src/channels/registration.ts";
import { registerWebhooks } from "../../../src/deploy/channel-ingress.ts";

const registered = (): Promise<RegistrationOutcome> => Promise.resolve("registered");
const webhook = (...names: string[]) => declaredChannels(names);
const longConnection = (...names: string[]) => declaredChannels(names, "long-connection");

describe("deploy/channel-ingress: which channels have a webhook", () => {
  it("does not register a long-connection channel either — the connection IS the ingress", async () => {
    const telegram = vi.fn(registered);
    const gate = await registerWebhooks({
      baseUrl: "https://x",
      channels: longConnection("telegram"),
      registrars: { telegram },
      log: () => {},
      retryHint: "re-run",
    });
    expect(telegram).not.toHaveBeenCalled();
    expect(gate).toBeUndefined();
  });

  it("a failed registrar gates, and one failure does not skip the rest", async () => {
    const feishu = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const gate = await registerWebhooks({
      baseUrl: "https://x",
      channels: webhook("telegram", "slack", "feishu", "lark"),
      registrars: { telegram: async () => "failed", feishu },
      log: () => {},
      retryHint: "re-run with --into-linked",
    });
    // Each kind reaches its own seam, with the kind it belongs to.
    expect(feishu.mock.calls).toEqual([
      ["https://x", "feishu"],
      ["https://x", "lark"],
    ]);
    expect(gate).toContain("telegram");
    expect(gate).toContain("re-run with --into-linked");
  });
});
