import { describe, expect, it, vi } from "vitest";
import { registerOwnWebhooks } from "../src/channels/webhooks.ts";
import { log } from "../src/log.ts";

vi.mock("../src/channels/telegram/register-webhook.ts", () => ({
  registerTelegramWebhook: async () => {
    throw new Error("boom");
  },
}));

describe("channels/webhooks: a registrar that throws", () => {
  it("ends its channel failed, said with why, never left pending", async () => {
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      expect(await registerOwnWebhooks("https://agent.example.com", ["telegram"], {})).toEqual([
        {
          channel: "telegram",
          outcome: "failed",
          url: "https://agent.example.com/telegram",
          step: "telegram: set the webhook → https://agent.example.com/telegram (secret_token = TELEGRAM_SECRET_TOKEN)",
        },
      ]);
      expect(errors).toHaveBeenCalledWith("[fastagent] telegram: could not register its webhook: Error: boom");
    } finally {
      errors.mockRestore();
    }
  });
});
