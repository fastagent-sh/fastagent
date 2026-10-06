/**
 * `fastagent add feishu|lark` app onboarding — the cloud-facing half of runAdd, kept out of cli.ts (which
 * self-executes on import), mirroring models-view.ts/auth-view.ts.
 */
import { readFile } from "node:fs/promises";
import { isCancel, log as clackLog, password, text as clackText } from "@clack/prompts";
import { bootstrapFeishuVerificationToken } from "../channels/feishu/bootstrap-token.ts";
import {
  FEISHU_AGENT_SCOPES,
  type FeishuScopeRequest,
  type FeishuSubscriptionMode,
  feishuAppAddons,
  feishuScopeRequestUrl,
  scopeSatisfied,
} from "../channels/feishu/setup-mode.ts";
import { cloudFor } from "../channels/feishu/cloud.ts";
import {
  createFeishuApi,
  type FeishuApi,
  isFeishuConfigApiMissing,
  isTransientFeishuRegistrationError,
} from "../channels/feishu/feishu-api.ts";
import { registerFeishuApp } from "../channels/feishu/register-app.ts";
import { onboardLarkApp } from "../channels/lark/onboard.ts";
import { dotEnvPath, parseEnvContent } from "../env.ts";
import { openExternalUrl } from "../open-url.ts";
import { appendChannelDotEnv } from "../scaffold/add-channel.ts";
import { startCloudflareTunnel } from "../tunnel.ts";

export interface AgentScopeCheck {
  /** Safe to proceed to version publishing now; false means Permissions still needs console or admin work. */
  publishReady: boolean;
}

/**
 * Check that the app holds {@link FEISHU_AGENT_SCOPES}. A created app asks for them on its confirm page, and a tenant
 * may still withhold some (its approval policy, or an app made by hand): those are NAMED, and the console page that
 * requests them is opened pre-filled. Nothing is requested through the config API — that needs a scope of its own,
 * which a tenant can withhold just the same.
 */
export async function checkAgentScopes(input: {
  kind: "feishu" | "lark";
  appId: string;
  apiBase: string;
  api: Pick<FeishuApi, "listAppScopes">;
  note?: (message: string) => void;
  openUrl?: (url: string) => void;
}): Promise<AgentScopeCheck> {
  const { kind, appId, apiBase, api } = input;
  const note = input.note ?? ((message: string) => console.error(message));
  const openUrl = input.openUrl ?? openExternalUrl;
  const requested = FEISHU_AGENT_SCOPES.map((entry) => entry.request);
  let scopes: Awaited<ReturnType<FeishuApi["listAppScopes"]>>;
  try {
    scopes = await api.listAppScopes();
  } catch (error) {
    const url = feishuScopeRequestUrl(apiBase, appId, requested);
    note(
      `[fastagent] warn: could not read the ${kind} app's permissions: ${String(error)} — make sure it holds ` +
        `${requested.join(", ")} before publishing. Opening ${url}`,
    );
    openUrl(url);
    return { publishReady: false };
  }
  // A user-type entry is not the tenant scope the app acts with.
  const tenant = scopes.filter((scope) => scope.type === undefined || scope.type === "tenant");
  const granted = (name: string): boolean => tenant.some((scope) => scope.name === name && scope.grantStatus === 1);
  const onApp = (name: string): boolean => tenant.some((scope) => scope.name === name);
  const missing = FEISHU_AGENT_SCOPES.filter((entry) => !scopeSatisfied(entry, granted));
  if (missing.length === 0) {
    note(`[fastagent] ${kind} app permissions: ${requested.join(", ")} granted`);
    return { publishReady: true };
  }
  const describe = (entry: FeishuScopeRequest): string =>
    `${entry.request} (${scopeSatisfied(entry, onApp) ? "awaiting approval" : "not on the app"})`;
  const url = feishuScopeRequestUrl(
    apiBase,
    appId,
    missing.map((entry) => entry.request),
  );
  note(
    `[fastagent] the ${kind} app lacks ${missing.map(describe).join(", ")} — the agent cannot hear its group ` +
      `chats fully without them. Request them, and have a tenant admin approve them if your tenant requires it, ` +
      `before publishing. Opening ${url}`,
  );
  openUrl(url);
  return { publishReady: false };
}

/** Create or resume the platform app behind `add feishu` / `add lark`. */
export async function onboardFeishuCloudApp(
  target: string,
  kind: "feishu" | "lark",
  ingress: FeishuSubscriptionMode = "webhook",
): Promise<Record<string, string> | undefined> {
  const env = dotEnvPath(target); // the file actually written — never the default spelling
  const { envPrefix, apiBase, capabilities } = cloudFor(kind);
  const requiredNames = [
    `${envPrefix}_APP_ID`,
    `${envPrefix}_APP_SECRET`,
    ...(ingress === "webhook" ? [`${envPrefix}_VERIFICATION_TOKEN`] : []),
  ];
  const existing = await activeDotEnvValues(target, requiredNames);
  if (Object.keys(existing).length === requiredNames.length) {
    console.error(`[fastagent] ${requiredNames.join("/")} already set in ${env} — keeping them`);
    // WebSocket still needs its console mode/publish guidance.
    if (ingress === "webhook") {
      const appId = existing[`${envPrefix}_APP_ID`] as string;
      const appSecret = existing[`${envPrefix}_APP_SECRET`] as string;
      await checkAgentScopes({
        kind,
        appId,
        apiBase,
        api: createFeishuApi({ kind, baseUrl: apiBase, appId, appSecret }),
      });
      return undefined;
    }
  }

  if (capabilities.appCreation === "scan-to-create") {
    await createFeishuAppFlow(target, existing, ingress);
    return undefined;
  }

  // guided-console (lark): the intl cloud cannot complete the bound device flow — collect + validate.
  if (
    !(process.stdin.isTTY && process.stdout.isTTY) &&
    !(existing[`${envPrefix}_APP_ID`] && existing[`${envPrefix}_APP_SECRET`])
  ) {
    throw new Error(
      "`add lark` needs an interactive terminal to onboard the Lark app credentials — re-run it in a terminal",
    );
  }
  const credentials = await onboardLarkApp(
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
      ingress,
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
            // A route-level 404 is definitive, not edge weather: fall back immediately.
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
  await checkAgentScopes({
    kind: "lark",
    appId: credentials.LARK_APP_ID,
    apiBase,
    api: createFeishuApi({
      kind: "lark",
      baseUrl: apiBase,
      appId: credentials.LARK_APP_ID,
      appSecret: credentials.LARK_APP_SECRET,
    }),
  });
  return Object.fromEntries(
    Object.entries(credentials).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** The scan-to-create flow `add feishu` runs by default. */
async function createFeishuAppFlow(
  target: string,
  existing: Readonly<Record<string, string>>,
  ingress: FeishuSubscriptionMode,
): Promise<void> {
  const env = dotEnvPath(target); // the file actually written — never the default spelling
  const { apiBase } = cloudFor("feishu");
  let appId = existing.FEISHU_APP_ID;
  let appSecret = existing.FEISHU_APP_SECRET;
  if (appId && appSecret) {
    console.error(
      ingress === "webhook"
        ? `[fastagent] resuming Feishu app ${appId} from ${env} to capture its missing Verification Token`
        : `[fastagent] reusing Feishu app ${appId} from ${env} for WebSocket ingress`,
    );
  } else {
    console.error(`[fastagent] creating the Feishu app (confirm in the app)…`);
    const app = await registerFeishuApp({
      name: "{user}'s agent", // the platform expands {user} to the confirming user's name; editable on the page
      desc: "Served by fastagent",
      // The agent template alone is not enough to SERVE, nor to hear a group (see feishuAppAddons).
      addons: feishuAppAddons(),
      onVerificationUrl: ({ url, expiresInS }) => {
        console.error(
          `\n  Opening the confirmation link in your browser (or open it in Feishu / render it as a QR code) — valid for ${Math.round(expiresInS / 60)} minutes:\n\n    ${url}\n\n  waiting for confirmation… (keep this running — the credentials are delivered here)`,
        );
        openExternalUrl(url); // best-effort, like `login` — the URL above is the fallback
      },
    });
    console.error(`[fastagent] app created: ${app.appId}${app.tenantBrand ? ` (${app.tenantBrand} tenant)` : ""}`);
    // A cross-brand confirmation should be impossible (each confirm page refuses the other brand's code).
    if (app.tenantBrand && app.tenantBrand !== "feishu") {
      throw new Error(
        `the confirming account is a ${app.tenantBrand} tenant, but this is \`add feishu\` — run \`fastagent add ${app.tenantBrand}\` instead`,
      );
    }
    appId = app.appId;
    appSecret = app.appSecret;

    // IRREVERSIBLE BOUNDARY: the remote app now exists and its one-time Secret is in memory.
    const staged = {
      FEISHU_APP_ID: appId,
      FEISHU_APP_SECRET: appSecret,
      ...(ingress === "webhook" ? { FEISHU_VERIFICATION_TOKEN: "" } : {}),
    };
    await appendChannelDotEnv(target, "feishu", staged, Object.keys(staged), ingress);
    console.error(
      ingress === "webhook"
        ? `[fastagent] wrote FEISHU_APP_ID, FEISHU_APP_SECRET to ${env} before Token bootstrap`
        : `[fastagent] wrote FEISHU_APP_ID, FEISHU_APP_SECRET to ${env}`,
    );
  }

  const groupSetup = await checkAgentScopes({
    kind: "feishu",
    appId,
    apiBase,
    api: createFeishuApi({ kind: "feishu", baseUrl: apiBase, appId, appSecret }),
  });

  if (ingress === "websocket") {
    const versionUrl = `${apiBase}/app/${appId}/version`;
    if (groupSetup.publishReady) {
      console.error(
        `[fastagent] WebSocket ingress needs no Verification Token, Encrypt Key, Request URL, or tunnel. ` +
          `Choose long connection in Events & Callbacks, then CREATE + PUBLISH a version. Opening ${versionUrl}`,
      );
      openExternalUrl(versionUrl);
    } else {
      console.error(
        `[fastagent] WebSocket ingress needs no Verification Token, Encrypt Key, Request URL, or tunnel. ` +
          `Choose long connection in Events & Callbacks, finish the permission work opened above, then CREATE + PUBLISH: ${versionUrl}`,
      );
    }
    return;
  }

  // The webhook channel authenticates plaintext events by the platform-generated Verification Token.
  const tokenVar = "FEISHU_VERIFICATION_TOKEN";
  const api = createFeishuApi({ baseUrl: apiBase, appId, appSecret });
  let token: string | undefined;
  let webhookModeChanged = false;
  try {
    const cfg = await api.getAppConfig(appId);
    token = cfg.verificationToken;
  } catch (error) {
    // Best-effort read; the bootstrap below is the real path. Said, because that path can take minutes and the reason
    // it was needed would otherwise be invisible.
    console.error(`[fastagent] could not read the app's Verification Token directly: ${(error as Error).message}`);
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
      // Transient tunnel weather is the usual cause.
      console.error(
        `[fastagent] warn: could not capture the Verification Token: ${String(e)} — usually a transient tunnel issue; finish this app with the manual copy below`,
      );
    }
  }
  if (token) {
    // Persist the second credential stage immediately too.
    const staged = await appendChannelDotEnv(target, "feishu", { [tokenVar]: token }, [tokenVar]);
    console.error(`[fastagent] wrote ${staged.written.join(", ")} to ${env}`);
  } else {
    console.error(
      `[fastagent] copy it manually: developer console → Events & Callbacks → Encryption Strategy → Verification Token → ${tokenVar} in ${env}`,
    );
  }
  if (webhookModeChanged) {
    // The bootstrap's PATCH flipped event mode in the DRAFT.
    const versionUrl = `${apiBase}/app/${appId}/version`;
    if (groupSetup.publishReady) {
      console.error(
        `[fastagent] one console click remains: CREATE + PUBLISH a version (self-approved) — the switch to webhook mode takes effect on publish. Opening ${versionUrl}`,
      );
      openExternalUrl(versionUrl);
    } else {
      console.error(
        `[fastagent] after the permission work opened above, CREATE + PUBLISH a version — the switch to webhook mode takes effect on publish: ${versionUrl}`,
      );
    }
  }
}

/**
 * Active agent `.env` (`.secrets/.env`) values for the requested names — decided by THE .env parser, so this check can
 * never disagree with what `loadDotEnv` reads.
 */
async function activeDotEnvValues(dir: string, names: string[]): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(dotEnvPath(dir), "utf8");
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
