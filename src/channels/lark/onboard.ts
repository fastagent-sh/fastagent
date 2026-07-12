/**
 * Guided Lark-international onboarding. The intl cloud cannot complete the scan-to-create flow and
 * does not expose the application-config API used by Feishu's Verification-Token bootstrap, so the
 * honest best path is: open the console, collect the two credentials, validate that pair against the
 * tenant-token endpoint, then collect the token the console displays. IO is injected so the workflow
 * is testable without a terminal or browser.
 */

export const LARK_CONSOLE_URL = "https://open.larksuite.com/app";

export interface LarkOnboardIO {
  openUrl(url: string): void;
  note(message: string): void;
  prompt(message: string, opts?: { hidden?: boolean }): Promise<string | undefined>;
}

export interface LarkOnboardOptions {
  /** Existing active .env values. A complete credential pair is reused (and still validated). */
  existing?: Readonly<Record<string, string | undefined>>;
  verifyCredentials(appId: string, appSecret: string): Promise<void>;
}

export interface LarkOnboardCredentials extends Record<string, string> {
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  LARK_VERIFICATION_TOKEN: string;
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required — re-run \`fastagent add lark\` to continue setup`);
  return trimmed;
}

/** Open the stable app console and collect everything the runtime needs. Cancellation is a visible
 * failure: the scaffold remains and `add lark` is deliberately re-runnable to resume onboarding. */
export async function onboardLarkApp(io: LarkOnboardIO, opts: LarkOnboardOptions): Promise<LarkOnboardCredentials> {
  io.note(`Create a Custom App in Lark Developer Console. Opening ${LARK_CONSOLE_URL}`);
  io.openUrl(LARK_CONSOLE_URL);

  const existingId = opts.existing?.LARK_APP_ID?.trim();
  const existingSecret = opts.existing?.LARK_APP_SECRET?.trim();
  // Reuse only a COMPLETE pair. A partial pair is not actionable and asking for both avoids combining
  // one stale value with one value from the newly-created app.
  const appId = required(
    existingId && existingSecret
      ? existingId
      : await io.prompt("LARK_APP_ID (Credentials & Basic Info)", { hidden: false }),
    "LARK_APP_ID",
  );
  const appSecret = required(
    existingId && existingSecret
      ? existingSecret
      : await io.prompt("LARK_APP_SECRET (Credentials & Basic Info)", { hidden: true }),
    "LARK_APP_SECRET",
  );

  await opts.verifyCredentials(appId, appSecret);
  io.note(
    "App ID / Secret verified. In this app, open Events & Callbacks → Encryption Strategy and copy the Verification Token.",
  );

  const verificationToken = required(
    opts.existing?.LARK_VERIFICATION_TOKEN?.trim() ||
      (await io.prompt("LARK_VERIFICATION_TOKEN (Events & Callbacks → Encryption Strategy)", { hidden: true })),
    "LARK_VERIFICATION_TOKEN",
  );

  return {
    LARK_APP_ID: appId,
    LARK_APP_SECRET: appSecret,
    LARK_VERIFICATION_TOKEN: verificationToken,
  };
}
