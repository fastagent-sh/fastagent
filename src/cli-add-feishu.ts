/**
 * `fastagent add feishu|lark` app onboarding — the cloud-facing half of runAdd, kept out of cli.ts
 * (which self-executes on import), mirroring cli-models.ts/cli-auth.ts. The POLICY already lives in
 * testable modules (register-app.ts, bootstrap-token.ts, lark/onboard.ts); this layer is the terminal
 * wiring: clack prompts, .env staging, browser opens, progress lines.
 *
 * Feishu (scan-to-create): the device flow creates the app; App ID/Secret are persisted at the
 * irreversible creation boundary, then the Verification Token is captured over a throwaway tunnel and
 * persisted as a second stage — a re-run RESUMES the app instead of minting another. Lark
 * (guided-console): open the unbound launcher, validate entered credentials, probe the same
 * webhook/token bootstrap, and fall back to a manual token prompt on the definitive config-route 404.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isCancel, log as clackLog, password, text as clackText } from "@clack/prompts";
import { bootstrapFeishuVerificationToken } from "./channels/feishu/bootstrap-token.ts";
import { cloudFor } from "./channels/feishu/cloud.ts";
import {
  createFeishuApi,
  isFeishuConfigApiMissing,
  isTransientFeishuRegistrationError,
} from "./channels/feishu/feishu-api.ts";
import { registerFeishuApp } from "./channels/feishu/register-app.ts";
import { onboardLarkApp } from "./channels/lark/onboard.ts";
import { parseEnvContent } from "./env.ts";
import { openExternalUrl } from "./open-url.ts";
import { appendChannelDotEnv } from "./scaffold/add-channel.ts";
import { startCloudflareTunnel } from "./tunnel.ts";

/**
 * Create or resume the platform app behind `add feishu` / `add lark`. Returns credentials for the
 * caller's generic .env write (the guided Lark path), or undefined when nothing remains to write —
 * the feishu path persists its own two credential stages internally (the App ID/Secret boundary is
 * irreversible and must not wait for the caller). Throws on refusal (a committable .env, a
 * non-interactive lark run); the caller surfaces that as a startup failure.
 */
export async function onboardFeishuCloudApp(
  target: string,
  kind: "feishu" | "lark",
  envIgnored: boolean,
): Promise<Record<string, string> | undefined> {
  const { envPrefix, apiBase, capabilities } = cloudFor(kind);
  // The CLI must never materialize a real credential into a committable file — refuse, don't warn.
  if (!envIgnored) {
    throw new Error(
      kind === "feishu"
        ? "`add feishu` creates an app and writes real credentials to .env — add .env to .gitignore/.fastagentignore first, then re-run"
        : "`add lark` writes real app credentials to .env — add .env to .gitignore/.fastagentignore first, then re-run",
    );
  }
  const existing = await activeDotEnvValues(target, [
    `${envPrefix}_APP_ID`,
    `${envPrefix}_APP_SECRET`,
    `${envPrefix}_VERIFICATION_TOKEN`,
  ]);
  if (Object.keys(existing).length === 3) {
    console.error(`[fastagent] ${envPrefix}_APP_ID/SECRET/VERIFICATION_TOKEN already set in .env — keeping them`);
    return undefined;
  }

  if (capabilities.appCreation === "scan-to-create") {
    await createFeishuAppFlow(target, existing);
    return undefined;
  }

  // guided-console (lark): the intl cloud cannot complete the bound device flow — collect + validate.
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error(
      "`add lark` needs an interactive terminal to onboard the Lark app credentials — re-run it in a terminal",
    );
  }
  return onboardLarkApp(
    {
      openUrl: openExternalUrl,
      note: (message) => clackLog.info(message),
      async prompt(message, opts) {
        const result = opts?.hidden ? await password({ message }) : await clackText({ message });
        return isCancel(result) ? undefined : (result as string);
      },
    },
    {
      existing,
      verifyCredentials: async (appId, appSecret) => {
        await createFeishuApi({ kind: "lark", baseUrl: apiBase, appId, appSecret }).verifyCredentials();
        console.error(`[fastagent] Lark App ID / Secret verified`);
      },
      bootstrapWebhook: async (appId, appSecret) => {
        const api = createFeishuApi({ kind: "lark", baseUrl: apiBase, appId, appSecret });
        console.error(`[fastagent] trying Lark's webhook-mode + Verification-Token bootstrap (temporary tunnel)…`);
        try {
          const token = await bootstrapFeishuVerificationToken({
            api,
            appId,
            kind: "lark",
            startTunnel: (port) => startCloudflareTunnel(port),
            onTunnelReady: (url) =>
              console.error(`[fastagent] temporary tunnel ready → ${url}; registering webhook mode now…`),
            onPatchRetry: ({ error, attempt, attempts, retryMs }) =>
              console.error(
                `[fastagent] Lark could not validate the fresh tunnel yet (${String(error)}); retrying PATCH ${attempt + 1}/${attempts} in ${Math.round(retryMs / 1000)}s…`,
              ),
            // A route-level 404 is definitive, not edge weather: fall back immediately. Retry only
            // actual edge/network weather; scope/auth/config failures remain immediate.
            shouldRetryPatch: (error) => !isFeishuConfigApiMissing(error) && isTransientFeishuRegistrationError(error),
          });
          console.error(
            `[fastagent] Lark Verification Token captured; Subscription mode changed to webhook in the app draft`,
          );
          return { token };
        } catch (error) {
          if (!isFeishuConfigApiMissing(error)) throw error;
          const manualReason =
            "This Lark app returned HTTP 404 for the application-config API, so automatic mode/token bootstrap is unavailable.";
          console.error(`[fastagent] ${manualReason}`);
          return { manualReason };
        }
      },
    },
  );
}

/**
 * The scan-to-create flow `add feishu` runs by default. The device-authorization grant
 * creates a pre-configured agent app (bot capability, messaging scopes, event subscriptions) when the
 * user confirms a link in the app, and hands back the credentials; App ID/Secret are persisted at that
 * irreversible boundary before the platform-generated Verification Token is captured from the
 * registration challenge (bootstrap-token.ts). The Token is persisted as a second stage, so .env is
 * complete before the one remaining version-publish action. The event Request URL is NOT left pointing at the throwaway
 * tunnel for long: `dev --tunnel` / `deploy --run` re-register it against the live URL.
 *
 * Feishu is the reference cloud and the only kind that runs this BOUND device flow. Lark is an explicit
 * compatibility profile: its lagging control plane uses the unbound launcher + guided credentials,
 * then probes the canonical token/mode bootstrap with a manual fallback.
 */
async function createFeishuAppFlow(target: string, existing: Readonly<Record<string, string>>): Promise<void> {
  const { apiBase } = cloudFor("feishu");
  let appId = existing.FEISHU_APP_ID;
  let appSecret = existing.FEISHU_APP_SECRET;
  if (appId && appSecret) {
    console.error(`[fastagent] resuming Feishu app ${appId} from .env to capture its missing Verification Token`);
  } else {
    console.error(`[fastagent] creating the Feishu app (confirm in the app)…`);
    const app = await registerFeishuApp({
      name: "{user}'s agent", // the platform expands {user} to the confirming user's name; editable on the page
      desc: "Served by fastagent",
      // The agent template alone is not enough to SERVE: the v7 config PATCH (webhook auto-registration
      // in `dev --tunnel` / `deploy --run`) demands application:application:patch, and the app must
      // subscribe the receive event. Addons merge both onto the confirm page — no manual app setup.
      addons: {
        scopes: { tenant: ["application:application:patch"] },
        events: { items: { tenant: ["im.message.receive_v1"] } },
      },
      onVerificationUrl: ({ url, expiresInS }) => {
        console.error(
          `\n  Opening the confirmation link in your browser (or open it in Feishu / render it as a QR code) — valid for ${Math.round(expiresInS / 60)} minutes:\n\n    ${url}\n\n  waiting for confirmation… (keep this running — the credentials are delivered here)`,
        );
        openExternalUrl(url); // best-effort, like `login` — the URL above is the fallback
      },
    });
    console.error(`[fastagent] app created: ${app.appId}${app.tenantBrand ? ` (${app.tenantBrand} tenant)` : ""}`);
    // A cross-brand confirmation should be impossible (each confirm page refuses the other brand's
    // code) — but if the platform ever reports one, the credentials would land in the WRONG kind's env
    // namespace and serve the wrong cloud. Fail visibly instead of writing them.
    if (app.tenantBrand && app.tenantBrand !== "feishu") {
      throw new Error(
        `the confirming account is a ${app.tenantBrand} tenant, but this is \`add feishu\` — run \`fastagent add ${app.tenantBrand}\` instead`,
      );
    }
    appId = app.appId;
    appSecret = app.appSecret;

    // IRREVERSIBLE BOUNDARY: the remote app now exists and its one-time Secret is in memory. Persist
    // both before any config read, temporary tunnel, or Token bootstrap can be interrupted. Partial old
    // lines are overwritten because these newly-minted credentials are authoritative as one pair.
    await appendChannelDotEnv(
      target,
      "feishu",
      {
        FEISHU_APP_ID: appId,
        FEISHU_APP_SECRET: appSecret,
        // A Token from a partial OLD credential set belongs to another App. Clear it at the same
        // boundary; successful bootstrap below replaces the empty line with this App's Token.
        FEISHU_VERIFICATION_TOKEN: "",
      },
      ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"],
    );
    console.error(`[fastagent] wrote FEISHU_APP_ID, FEISHU_APP_SECRET to .env before Token bootstrap`);
  }

  // The webhook channel authenticates plaintext events by the platform-generated Verification Token.
  // Try the cheap read first (the v6 detail MAY someday return `encryption`), then the real path: the
  // token's only programmatic delivery is the url_verification challenge during registration — capture
  // it over a throwaway tunnel (bootstrap-token.ts). Failing both is a one-line manual copy; the staged
  // ID/Secret pair makes a re-run resume this App rather than mint another one.
  const tokenVar = "FEISHU_VERIFICATION_TOKEN";
  const api = createFeishuApi({ baseUrl: apiBase, appId, appSecret });
  let token: string | undefined;
  let webhookModeChanged = false;
  try {
    const cfg = await api.getAppConfig(appId);
    token = cfg.verificationToken;
  } catch {
    /* the read surface is best-effort — the bootstrap below is the real path */
  }
  if (!token) {
    console.error(
      `[fastagent] capturing the Verification Token — a throwaway webhook registration delivers it (spinning up a temporary tunnel; can take a few minutes on a slow edge)…`,
    );
    try {
      token = await bootstrapFeishuVerificationToken({
        api,
        appId,
        startTunnel: (port) => startCloudflareTunnel(port),
      });
      webhookModeChanged = true;
      console.error(`[fastagent] Verification Token captured`);
    } catch (e) {
      // Transient tunnel weather is the usual cause. Do NOT suggest re-running `add feishu` as a new
      // scan: the staged pair makes the re-run resume THIS app; manual copy completes it too.
      console.error(
        `[fastagent] warn: could not capture the Verification Token: ${String(e)} — usually a transient tunnel issue; finish this app with the manual copy below`,
      );
    }
  }
  if (token) {
    // Persist the second credential stage immediately too — opening the publish page and generic
    // scaffold finalization happen only after the complete runtime credential set is durable.
    const staged = await appendChannelDotEnv(target, "feishu", { [tokenVar]: token }, [tokenVar]);
    console.error(`[fastagent] wrote ${staged.written.join(", ")} to .env`);
  } else {
    console.error(
      `[fastagent] copy it manually: developer console → Events & Callbacks → Encryption Strategy → Verification Token → ${tokenVar} in .env`,
    );
  }
  if (webhookModeChanged) {
    // The bootstrap's PATCH flipped event mode in the DRAFT. It takes effect only after a version
    // publish, which has no API; later dev/deploy runs change only the Request URL immediately.
    const versionUrl = `${apiBase}/app/${appId}/version`;
    console.error(
      `[fastagent] one console click remains: CREATE + PUBLISH a version (self-approved) — the switch to webhook mode takes effect on publish. Opening ${versionUrl}`,
    );
    openExternalUrl(versionUrl);
  }
}

/** Active run-root `.env` values for the requested names — decided by THE .env parser, so this
 * check can never disagree with what `loadEnvFile` reads. Empty/commented values are absent. */
async function activeDotEnvValues(dir: string, names: string[]): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(join(dir, ".env"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const parsed = parseEnvContent(content);
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = parsed.get(name)?.trim();
      return value ? [[name, value]] : [];
    }),
  );
}
