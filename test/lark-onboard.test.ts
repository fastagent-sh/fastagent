import { describe, expect, it, vi } from "vitest";
import { LARK_CONSOLE_URL, type LarkOnboardIO, onboardLarkApp } from "../src/channels/lark/onboard.ts";

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

describe("guided Lark app onboarding", () => {
  it("opens the console, collects ID then secret, validates the pair, then collects the token", async () => {
    const fx = fakeIO([" cli_app ", " secret ", " verify "]);
    const verifyCredentials = vi.fn(async () => {});

    await expect(onboardLarkApp(fx.io, { verifyCredentials })).resolves.toEqual({
      LARK_APP_ID: "cli_app",
      LARK_APP_SECRET: "secret",
      LARK_VERIFICATION_TOKEN: "verify",
    });
    expect(LARK_CONSOLE_URL).toBe("https://open.larksuite.com/page/launcher?from=backend_oneclick");
    expect(fx.opened).toEqual([LARK_CONSOLE_URL]);
    expect(fx.prompts.map((p) => p.message)).toEqual([
      expect.stringContaining("LARK_APP_ID"),
      expect.stringContaining("LARK_APP_SECRET"),
      expect.stringContaining("LARK_VERIFICATION_TOKEN"),
    ]);
    expect(fx.prompts.map((p) => p.hidden)).toEqual([false, true, true]);
    expect(verifyCredentials).toHaveBeenCalledWith("cli_app", "secret");
    expect(fx.notes.at(-1)).toContain("Events & Callbacks");
  });

  it("reuses and validates an existing complete ID/secret pair, prompting only for a missing token", async () => {
    const fx = fakeIO(["new-token"]);
    const verifyCredentials = vi.fn(async () => {});

    await expect(
      onboardLarkApp(fx.io, {
        existing: { LARK_APP_ID: "cli_existing", LARK_APP_SECRET: "kept" },
        verifyCredentials,
      }),
    ).resolves.toEqual({
      LARK_APP_ID: "cli_existing",
      LARK_APP_SECRET: "kept",
      LARK_VERIFICATION_TOKEN: "new-token",
    });
    expect(fx.prompts).toHaveLength(1);
    expect(fx.prompts[0]?.message).toContain("LARK_VERIFICATION_TOKEN");
    expect(verifyCredentials).toHaveBeenCalledWith("cli_existing", "kept");
  });

  it("does not persist unvalidated credentials and fails visibly on cancellation", async () => {
    const verifyFailure = new Error("code 10003 invalid app credentials");
    const bad = fakeIO(["cli_bad", "bad-secret"]);
    await expect(onboardLarkApp(bad.io, { verifyCredentials: async () => Promise.reject(verifyFailure) })).rejects.toBe(
      verifyFailure,
    );
    expect(bad.prompts).toHaveLength(2); // token is requested only AFTER validation

    const cancelled = fakeIO([undefined]);
    await expect(onboardLarkApp(cancelled.io, { verifyCredentials: async () => {} })).rejects.toThrow(
      /LARK_APP_ID is required/,
    );
  });

  it("keeps an existing Verification Token while collecting a missing credential pair", async () => {
    const fx = fakeIO(["cli_new", "new-secret"]);
    await expect(
      onboardLarkApp(fx.io, {
        existing: { LARK_VERIFICATION_TOKEN: "kept-token" },
        verifyCredentials: async () => {},
      }),
    ).resolves.toEqual({
      LARK_APP_ID: "cli_new",
      LARK_APP_SECRET: "new-secret",
      LARK_VERIFICATION_TOKEN: "kept-token",
    });
    expect(fx.prompts).toHaveLength(2);
  });
});
