/**
 * `fastagent add feishu|lark` app onboarding — the cloud-facing half of runAdd, kept out of cli.ts
 * (which self-executes on import), mirroring models-view.ts/auth-view.ts. The POLICY already lives in
 * testable modules (register-app.ts, bootstrap-token.ts, lark/onboard.ts); this layer is the terminal
 * wiring: clack prompts, .env staging, browser opens, progress lines.
 *
 * Feishu (scan-to-create): the device flow creates the app and persists App ID/Secret at the
 * irreversible boundary. WebSocket stops there; webhook additionally captures the Verification Token
 * over a throwaway tunnel. Lark uses the unbound launcher + credential validation, then either stops
 * for WebSocket or probes the same webhook/token bootstrap with the config-route-404 manual fallback.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isCancel, log as clackLog, password, text as clackText } from "@clack/prompts";
import { bootstrapFeishuVerificationToken } from "../channels/feishu/bootstrap-token.ts";
import {
  FEISHU_GROUP_CONTEXT_SCOPE,
  FEISHU_CONTEXT_ONBOARDING_SCOPES,
  FEISHU_MESSAGE_READ_SCOPE,
  scopeSatisfied,
  type FeishuGroupBehavior,
  type FeishuSubscriptionMode,
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
import { parseEnvContent } from "../env.ts";
import { openExternalUrl } from "../open-url.ts";
import { appendChannelDotEnv, type GroupBehaviorChoice } from "../scaffold/add-channel.ts";
import { startCloudflareTunnel } from "../tunnel.ts";

export interface GroupBehaviorSetup {
  /** Safe to proceed to version publishing now; false means Permissions still needs manual/admin work. */
  publishReady: boolean;
}

export async function configureGroupBehavior(input: {
  kind: "feishu" | "lark";
  appId: string;
  apiBase: string;
  api: Pick<FeishuApi, "listAppScopes" | "addAppScopes">;
  behavior: FeishuGroupBehavior;
  /** Whether the author chose the behavior (flag or prompt). A defaulted "context" inspects and
   * reports only — it must never PATCH the sensitive scope into the app draft. */
  explicit: boolean;
  note?: (message: string) => void;
  openUrl?: (url: string) => void;
}): Promise<GroupBehaviorSetup> {
  const { kind, appId, apiBase, api, behavior, explicit } = input;
  const note = input.note ?? ((message: string) => console.error(message));
  const openUrl = input.openUrl ?? openExternalUrl;
  let scopes: Awaited<ReturnType<FeishuApi["listAppScopes"]>>;
  let inspected = true;
  try {
    scopes = await api.listAppScopes();
  } catch (error) {
    note(
      `[fastagent] warn: could not inspect ${kind} group-message permission: ${String(error)} — check Permissions & Scopes manually`,
    );
    inspected = false;
    scopes = [];
  }
  const granted = (name: string): boolean =>
    scopes.some(
      (scope) =>
        scope.name === name && scope.grantStatus === 1 && (scope.type === undefined || scope.type === "tenant"),
    );
  // Same type filter as `granted`: a user-type entry is not the tenant scope this path needs, so
  // treating one as "on the app" would report an approval that can never arrive and skip the PATCH
  // that would actually add it.
  const onApp = (name: string): boolean =>
    scopes.some((scope) => scope.name === name && (scope.type === undefined || scope.type === "tenant"));
  // Both halves of the recommended path: delivery (the platform pushes un-mentioned group messages)
  // and reading a quoted message (so a thread's opening ask carries what it replies to).
  // The read capability has two spellings and `im:message` is the superset, so an app holding it needs
  // nothing added — asking anyway would cost the author a second tenant-admin approval round.
  const missing = FEISHU_CONTEXT_ONBOARDING_SCOPES.filter((entry) => !scopeSatisfied(entry, granted));
  const missingNames = missing.map((entry) => entry.request);

  if (behavior === "mentions") {
    if (!inspected) {
      const permissionUrl = `${apiBase}/app/${encodeURIComponent(appId)}/permission`;
      note(
        `[fastagent] mention-only scope state could not be verified — check Permissions before publishing. Opening ${permissionUrl}`,
      );
      openUrl(permissionUrl);
      return { publishReady: false };
    }
    if (granted(FEISHU_GROUP_CONTEXT_SCOPE)) {
      const permissionUrl = `${apiBase}/app/${encodeURIComponent(appId)}/permission`;
      note(
        `[fastagent] warn: mention-only was selected, but ${FEISHU_GROUP_CONTEXT_SCOPE} is already granted — remove it before publishing a new version to restore least-privilege platform delivery. Opening ${permissionUrl}`,
      );
      openUrl(permissionUrl);
      return { publishReady: false };
    }
    note(
      `[fastagent] group behavior: mention-only — bare replies in the Agent's threads and group context buffering are disabled. ` +
        `Add ${FEISHU_MESSAGE_READ_SCOPE} by hand if you want an @mention to carry the message it quotes`,
    );
    return { publishReady: true };
  }

  note(
    `[fastagent] group behavior: context-aware (recommended) — ${kind} will deliver all group messages; ` +
      `FastAgent invokes @Agent, answers bare replies in threads it takes part in, and durably buffers ` +
      `other discussion. ${FEISHU_GROUP_CONTEXT_SCOPE} (delivery) is required; ${FEISHU_MESSAGE_READ_SCOPE} ` +
      `(reading a quoted message) is requested with it — without it a quoted message degrades to a marker`,
  );
  if (missing.length === 0) {
    note(
      `[fastagent] ${FEISHU_CONTEXT_ONBOARDING_SCOPES.map((entry) => entry.request).join(" + ")} are already granted`,
    );
    return { publishReady: true };
  }
  const permissionUrl = `${apiBase}/app/${encodeURIComponent(appId)}/permission`;
  // A missing scope is in one of two states, and they need different actions: already on the app but
  // not yet approved (nothing to add — wait for the admin), or absent from the draft entirely.
  // Same superset rule as `missing`: a draft already requesting `im:message` is awaiting approval, not
  // missing something to add.
  const awaitingApproval = missing.filter((entry) => scopeSatisfied(entry, onApp)).map((entry) => entry.request);
  const toRequest = missing.filter((entry) => !scopeSatisfied(entry, onApp)).map((entry) => entry.request);
  if (toRequest.length === 0) {
    note(
      `[fastagent] ${awaitingApproval.join(" + ")} awaiting approval — complete tenant-admin approval before publishing. Opening ${permissionUrl}`,
    );
    openUrl(permissionUrl);
    return { publishReady: false };
  }
  if (!explicit) {
    // Defaulted, not chosen: report the gap and how to opt in, but leave the app's requested
    // permission set untouched (a scripted re-run must not silently escalate a mention-only app).
    // Name what is ACTUALLY missing: the common upgrade has the delivery scope already granted and
    // only the read scope absent, and pointing at a granted permission sends the author looking in
    // the wrong place.
    note(
      `[fastagent] ${missingNames.join(" + ")} not granted (or could not be verified) — group behavior was ` +
        `defaulted, so nothing was requested. Re-run with --group-behavior context to add ${missing.length > 1 ? "them" : "it"} ` +
        `to the app draft, or --group-behavior mentions to stay least-privilege: ${permissionUrl}`,
    );
    return { publishReady: false };
  }
  try {
    await api.addAppScopes(appId, toRequest);
    note(
      `[fastagent] added ${toRequest.join(" + ")} to the app draft — complete tenant-admin approval before publishing. Opening ${permissionUrl}`,
    );
  } catch (error) {
    note(
      `[fastagent] warn: could not add ${toRequest.join(" + ")} automatically: ${String(error)} — add it manually before publishing. Opening ${permissionUrl}`,
    );
  }
  openUrl(permissionUrl);
  return { publishReady: false };
}

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
  ingress: FeishuSubscriptionMode = "webhook",
  groupBehavior: GroupBehaviorChoice = { behavior: "context", explicit: false },
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
  const requiredNames = [
    `${envPrefix}_APP_ID`,
    `${envPrefix}_APP_SECRET`,
    ...(ingress === "webhook" ? [`${envPrefix}_VERIFICATION_TOKEN`] : []),
  ];
  const existing = await activeDotEnvValues(target, requiredNames);
  if (Object.keys(existing).length === requiredNames.length) {
    console.error(`[fastagent] ${requiredNames.join("/")} already set in .env — keeping them`);
    // WebSocket still needs its console mode/publish guidance. A complete webhook can skip the rest of
    // onboarding, but group visibility must still be inspected/configured on every explicit re-run.
    if (ingress === "webhook") {
      const appId = existing[`${envPrefix}_APP_ID`] as string;
      const appSecret = existing[`${envPrefix}_APP_SECRET`] as string;
      await configureGroupBehavior({
        kind,
        appId,
        apiBase,
        api: createFeishuApi({ kind, baseUrl: apiBase, appId, appSecret }),
        behavior: groupBehavior.behavior,
        explicit: groupBehavior.explicit,
      });
      return undefined;
    }
  }

  if (capabilities.appCreation === "scan-to-create") {
    await createFeishuAppFlow(target, existing, ingress, groupBehavior);
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
      groupBehavior: groupBehavior.behavior,
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
  await configureGroupBehavior({
    kind: "lark",
    appId: credentials.LARK_APP_ID,
    apiBase,
    api: createFeishuApi({
      kind: "lark",
      baseUrl: apiBase,
      appId: credentials.LARK_APP_ID,
      appSecret: credentials.LARK_APP_SECRET,
    }),
    behavior: groupBehavior.behavior,
    explicit: groupBehavior.explicit,
  });
  return Object.fromEntries(
    Object.entries(credentials).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * The scan-to-create flow `add feishu` runs by default. The device-authorization grant
 * creates a pre-configured agent app (bot capability, messaging scopes, event subscriptions) when the
 * user confirms a link, then persists App ID/Secret at the irreversible boundary. That completes
 * WebSocket credentials; webhook continues through challenge-captured Token persistence. The throwaway
 * Request URL is later replaced by `dev --tunnel` / `deploy --run`.
 *
 * Feishu is the reference cloud and the only kind that runs this BOUND device flow. Lark is an explicit
 * compatibility profile: its lagging control plane uses the unbound launcher + guided credentials,
 * then probes the canonical token/mode bootstrap with a manual fallback.
 */
async function createFeishuAppFlow(
  target: string,
  existing: Readonly<Record<string, string>>,
  ingress: FeishuSubscriptionMode,
  groupBehavior: GroupBehaviorChoice,
): Promise<void> {
  const { apiBase } = cloudFor("feishu");
  let appId = existing.FEISHU_APP_ID;
  let appSecret = existing.FEISHU_APP_SECRET;
  if (appId && appSecret) {
    console.error(
      ingress === "webhook"
        ? `[fastagent] resuming Feishu app ${appId} from .env to capture its missing Verification Token`
        : `[fastagent] reusing Feishu app ${appId} from .env for WebSocket ingress`,
    );
  } else {
    console.error(`[fastagent] creating the Feishu app (confirm in the app)…`);
    const app = await registerFeishuApp({
      name: "{user}'s agent", // the platform expands {user} to the confirming user's name; editable on the page
      desc: "Served by fastagent",
      // The agent template alone is not enough to SERVE: v7 config PATCHes (webhook registration and
      // context-aware group scope setup) demand application:application:patch, and the app must subscribe
      // the receive event. Addons merge those BASE capabilities onto the confirm page; sensitive group
      // permission approval and version publishing remain explicit console work.
      addons: {
        ...(ingress === "webhook" || (groupBehavior.behavior === "context" && groupBehavior.explicit)
          ? { scopes: { tenant: ["application:application:patch"] } }
          : {}),
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
    const staged = {
      FEISHU_APP_ID: appId,
      FEISHU_APP_SECRET: appSecret,
      ...(ingress === "webhook" ? { FEISHU_VERIFICATION_TOKEN: "" } : {}),
    };
    await appendChannelDotEnv(target, "feishu", staged, Object.keys(staged), ingress);
    console.error(
      ingress === "webhook"
        ? `[fastagent] wrote FEISHU_APP_ID, FEISHU_APP_SECRET to .env before Token bootstrap`
        : `[fastagent] wrote FEISHU_APP_ID, FEISHU_APP_SECRET to .env`,
    );
  }

  const groupSetup = await configureGroupBehavior({
    kind: "feishu",
    appId,
    apiBase,
    api: createFeishuApi({ kind: "feishu", baseUrl: apiBase, appId, appSecret }),
    behavior: groupBehavior.behavior,
    explicit: groupBehavior.explicit,
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
