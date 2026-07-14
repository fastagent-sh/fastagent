import { describe, expect, it, vi } from "vitest";
import {
  LARK_CONSOLE_URL,
  type LarkOnboardIO,
  larkEventSecurityUrl,
  onboardLarkApp,
} from "../src/channels/lark/onboard.ts";

function fakeIO(answers: Array<string | undefined>): {
  io: LarkOnboardIO;
  prompts: Array<{ message: string; hidden?: boolean }>;
  notes: string[];
  opened: string[];
} {
  const prompts: Array<{ message: string; hidden?: boolean }> = [];
  const notes: string[] = [];
  const opened: string[] = [];
  return {
    prompts,
    notes,
    opened,
    io: {
      openUrl: (url) => opened.push(url),
      note: (message) => notes.push(message),
      async prompt(message, opts) {
        prompts.push({ message, hidden: opts?.hidden });
        return answers.shift();
      },
    },
  };
}

const manual404 = async () => ({ manualReason: "config API returned HTTP 404" });

describe("guided Lark app onboarding", () => {
  it("opens the launcher, validates ID/secret, then captures the token while switching webhook mode", async () => {
    const fx = fakeIO([" cli_app ", " secret "]);
    const verifyCredentials = vi.fn(async () => {});
    const bootstrapWebhook = vi.fn(async () => ({ token: "captured-token" }));

    await expect(onboardLarkApp(fx.io, { verifyCredentials, bootstrapWebhook })).resolves.toEqual({
      LARK_APP_ID: "cli_app",
      LARK_APP_SECRET: "secret",
      LARK_VERIFICATION_TOKEN: "captured-token",
    });
    expect(LARK_CONSOLE_URL).toBe("https://open.larksuite.com/page/launcher?from=backend_oneclick");
    expect(larkEventSecurityUrl("cli_app")).toBe("https://open.larksuite.com/app/cli_app/event?tab=safe");
    expect(fx.opened).toEqual([LARK_CONSOLE_URL, "https://open.larksuite.com/app/cli_app/event?tab=safe"]);
    expect(fx.prompts.map((p) => p.message)).toEqual([
      expect.stringContaining("LARK_APP_ID"),
      expect.stringContaining("LARK_APP_SECRET"),
    ]);
    expect(fx.prompts.map((p) => p.hidden)).toEqual([false, true]);
    expect(verifyCredentials).toHaveBeenCalledWith("cli_app", "secret");
    expect(bootstrapWebhook).toHaveBeenCalledWith("cli_app", "secret");
    expect(fx.notes.at(-1)).toContain("Subscription mode changed to webhook");
  });

  it("prompts for the console token only after a definitive config-API fallback", async () => {
    const fx = fakeIO(["cli_app", "secret", "manual-token"]);
    await expect(
      onboardLarkApp(fx.io, { verifyCredentials: async () => {}, bootstrapWebhook: manual404 }),
    ).resolves.toEqual({
      LARK_APP_ID: "cli_app",
      LARK_APP_SECRET: "secret",
      LARK_VERIFICATION_TOKEN: "manual-token",
    });
    expect(fx.prompts).toHaveLength(3);
    expect(fx.prompts[2]?.message).toContain("LARK_VERIFICATION_TOKEN");
    expect(fx.notes.at(-1)).toMatch(/HTTP 404.*switch Subscription mode to webhook/);
  });

  it("reuses and validates an existing complete ID/secret pair before bootstrap", async () => {
    const fx = fakeIO(["new-token"]);
    const verifyCredentials = vi.fn(async () => {});
    const bootstrapWebhook = vi.fn(manual404);

    await expect(
      onboardLarkApp(fx.io, {
        existing: { LARK_APP_ID: "cli_existing", LARK_APP_SECRET: "kept" },
        verifyCredentials,
        bootstrapWebhook,
      }),
    ).resolves.toEqual({
      LARK_APP_ID: "cli_existing",
      LARK_APP_SECRET: "kept",
      LARK_VERIFICATION_TOKEN: "new-token",
    });
    expect(fx.prompts).toHaveLength(1);
    expect(fx.opened).toEqual(["https://open.larksuite.com/app/cli_existing/event?tab=safe"]);
    expect(verifyCredentials).toHaveBeenCalledWith("cli_existing", "kept");
    expect(bootstrapWebhook).toHaveBeenCalledWith("cli_existing", "kept");
  });

  it("stops before bootstrap/token collection when credentials are invalid or input is cancelled", async () => {
    const verifyFailure = new Error("code 10003 invalid app credentials");
    const bootstrapWebhook = vi.fn(async () => ({ token: "must-not-run" }));
    const bad = fakeIO(["cli_bad", "bad-secret"]);
    await expect(
      onboardLarkApp(bad.io, {
        verifyCredentials: async () => Promise.reject(verifyFailure),
        bootstrapWebhook,
      }),
    ).rejects.toBe(verifyFailure);
    expect(bootstrapWebhook).not.toHaveBeenCalled();
    expect(bad.prompts).toHaveLength(2);

    const cancelled = fakeIO([undefined]);
    await expect(onboardLarkApp(cancelled.io, { verifyCredentials: async () => {}, bootstrapWebhook })).rejects.toThrow(
      /LARK_APP_ID is required/,
    );
  });

  it("never attaches an orphaned existing token to a newly entered App pair", async () => {
    const fx = fakeIO(["cli_new", "new-secret", "new-token"]);
    await expect(
      onboardLarkApp(fx.io, {
        existing: { LARK_VERIFICATION_TOKEN: "orphaned-token" },
        verifyCredentials: async () => {},
        bootstrapWebhook: manual404,
      }),
    ).resolves.toEqual({
      LARK_APP_ID: "cli_new",
      LARK_APP_SECRET: "new-secret",
      LARK_VERIFICATION_TOKEN: "new-token",
    });
    expect(fx.prompts).toHaveLength(3);
    expect(fx.opened).toEqual([LARK_CONSOLE_URL, "https://open.larksuite.com/app/cli_new/event?tab=safe"]);
  });

  it("reuses a token only with its complete existing App pair", async () => {
    const fx = fakeIO([]);
    await expect(
      onboardLarkApp(fx.io, {
        existing: {
          LARK_APP_ID: "cli_existing",
          LARK_APP_SECRET: "kept-secret",
          LARK_VERIFICATION_TOKEN: "kept-token",
        },
        verifyCredentials: async () => {},
        bootstrapWebhook: manual404,
      }),
    ).resolves.toEqual({
      LARK_APP_ID: "cli_existing",
      LARK_APP_SECRET: "kept-secret",
      LARK_VERIFICATION_TOKEN: "kept-token",
    });
    expect(fx.prompts).toHaveLength(0);
    expect(fx.opened).toEqual(["https://open.larksuite.com/app/cli_existing/event?tab=safe"]);
  });
});
