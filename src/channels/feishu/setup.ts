/**
 * What a Feishu or Lark app's setup asks for (channels/setup.ts). The two share one engine: the app's credentials come
 * first (Feishu creates the app by scan-to-create and keeps what it returns; Lark's person creates it in its console and
 * pastes them), then, for a webhook, the Verification Token, captured by a throwaway webhook registration when the app
 * allows it and pasted when it does not. What is left to the person is the permission work and the publish, which
 * depend on what the platform says about the app.
 */
import { type ChannelSetup, type HeldValues, type SetupValue, type SetupWay, pasteOne } from "../setup.ts";
import { bootstrapFeishuVerificationToken } from "./bootstrap-token.ts";
import { type FeishuCloudKind, cloudFor } from "./cloud.ts";
import {
  type FeishuApi,
  createFeishuApi,
  isFeishuConfigApiMissing,
  isTransientFeishuRegistrationError,
} from "./feishu-api.ts";
import { registerFeishuApp } from "./register-app.ts";
import {
  FEISHU_APP_CONFIG_SCOPE,
  FEISHU_MESSAGE_RECEIVE_EVENT,
  type FeishuScopeRequest,
  feishuAppAddons,
  feishuAppScopes,
  feishuScopeRequestUrl,
  scopeSatisfied,
} from "./setup-mode.ts";

const say = (message: string): void => console.error(`[fastagent] ${message}`);

/** The page of an app where its Verification Token is, and where the subscription mode is chosen. */
const eventPage = (kind: FeishuCloudKind, appId: string): string =>
  `${cloudFor(kind).apiBase}/app/${encodeURIComponent(appId)}/event?tab=safe`;

interface ScopeFindings {
  /** The scopes found missing; empty when the list could not be read. */
  missing: string[];
  /** What to tell the person; empty when the app holds everything it needs. */
  lines: string[];
}

/**
 * What the app holds of what an app of this way needs ({@link feishuAppScopes}). A created app asks for them on its
 * confirm page, and a tenant may still withhold some (its approval policy, or an app made by hand): those are NAMED,
 * with what each one costs, and the console page that requests them is linked pre-filled. Nothing is requested through
 * the config API: that needs a scope of its own, which a tenant can withhold just the same.
 */
async function agentScopes(
  kind: FeishuCloudKind,
  way: SetupWay,
  appId: string,
  api: Pick<FeishuApi, "listAppScopes">,
): Promise<ScopeFindings> {
  const apiBase = cloudFor(kind).apiBase;
  const needed = feishuAppScopes(way);
  const requested = needed.map((entry) => entry.request);
  let scopes: Awaited<ReturnType<FeishuApi["listAppScopes"]>>;
  try {
    scopes = await api.listAppScopes();
  } catch (error) {
    return {
      missing: [],
      lines: [
        `could not read the ${kind} app's permissions (${String(error)}): make sure it holds ${requested.join(", ")} ` +
          `before publishing: ${feishuScopeRequestUrl(apiBase, appId, requested)}`,
      ],
    };
  }
  // A user-type entry is not the tenant scope the app acts with.
  const tenant = scopes.filter((scope) => scope.type === undefined || scope.type === "tenant");
  const granted = (name: string): boolean => tenant.some((scope) => scope.name === name && scope.grantStatus === 1);
  const missing = needed.filter((entry) => !scopeSatisfied(entry, granted));
  if (missing.length === 0) {
    say(`${kind} app permissions: ${requested.join(", ")} granted`);
    return { missing: [], lines: [] };
  }
  // "Not granted", not "not requested": the list omits a scope still under review (measured), so the two look alike.
  const describe = (entry: FeishuScopeRequest): string => `\n  ${entry.request}: without it ${entry.withoutIt}`;
  const url = feishuScopeRequestUrl(
    apiBase,
    appId,
    missing.map((entry) => entry.request),
  );
  return {
    missing: missing.map((entry) => entry.request),
    lines: [
      `the ${kind} app is not granted:${missing.map(describe).join("")}\n` +
        `Tick and enable them at ${url} (one may already be awaiting a tenant admin's approval), before publishing`,
    ],
  };
}

/** The setup of a Feishu or Lark app whose credentials are `credentials`. */
export function feishuEngine(
  kind: FeishuCloudKind,
  credentials: SetupValue,
  context: Parameters<ChannelSetup>[0],
): ReturnType<ChannelSetup> {
  const { way, publicUrl, startTunnel } = context;
  const { envPrefix, apiBase } = cloudFor(kind);
  const idName = `${envPrefix}_APP_ID`;
  const tokenName = `${envPrefix}_VERIFICATION_TOKEN`;
  const idOf = (held: HeldValues): string => held.get(idName) as string;
  const apiOf = (held: HeldValues): FeishuApi =>
    createFeishuApi({
      kind,
      baseUrl: apiBase,
      appId: idOf(held),
      appSecret: held.get(`${envPrefix}_APP_SECRET`) as string,
    });

  let scopes: Promise<ScopeFindings> | undefined;
  const scopesOf = (held: HeldValues): Promise<ScopeFindings> =>
    (scopes ??= agentScopes(kind, way, idOf(held), apiOf(held)));

  /** How the Verification Token came, when the setup went looking for it. */
  let token: "read" | "captured" | "pasted" | undefined;

  async function capture(held: HeldValues): Promise<string | undefined> {
    const appId = idOf(held);
    const api = apiOf(held);
    try {
      const config = await api.getAppConfig(appId);
      if (config.verificationToken) {
        token = "read";
        return config.verificationToken;
      }
    } catch (error) {
      if (isFeishuConfigApiMissing(error)) {
        say(
          `this ${kind} app returned HTTP 404 for the application-config API, so its Verification Token cannot be captured automatically`,
        );
        token = "pasted";
        return undefined;
      }
      say(`could not read the app's Verification Token directly: ${(error as Error).message}`);
    }
    // The capture registers a Request URL through the config scope; without it every attempt is refused.
    if ((await scopesOf(held)).missing.includes(FEISHU_APP_CONFIG_SCOPE)) {
      say(
        `not capturing the Verification Token: the app is not granted ${FEISHU_APP_CONFIG_SCOPE}. Paste it from the ` +
          `console, or have the permission approved and run \`${context.rerun}\` again`,
      );
      token = "pasted";
      return undefined;
    }
    say(
      "capturing the Verification Token: a throwaway webhook registration delivers it (a temporary tunnel; can take a few minutes on a slow edge)…",
    );
    try {
      const captured = await bootstrapFeishuVerificationToken({
        api,
        appId,
        kind,
        startTunnel,
        onTunnelReady: (url) => say(`temporary tunnel ready → ${url}; registering webhook mode now…`),
        onPatchRetry: ({ error, attempt, attempts, retryMs }) =>
          say(
            `${kind} could not validate the fresh tunnel yet (${String(error)}); retrying PATCH ${attempt + 1}/${attempts} in ${Math.round(retryMs / 1000)}s…`,
          ),
        // Only edge weather is retried; a refusal (scope, auth, app under review) is reported as itself.
        shouldRetryPatch: (error) => !isFeishuConfigApiMissing(error) && isTransientFeishuRegistrationError(error),
      });
      say("Verification Token captured; Subscription mode changed to webhook in the app draft");
      token = "captured";
      return captured;
    } catch (error) {
      say(`warn: could not capture the Verification Token: ${String(error)}: paste it from the console`);
      token = "pasted";
      return undefined;
    }
  }

  const values: SetupValue[] = [
    credentials,
    ...(way === "webhook"
      ? [
          pasteOne({
            name: tokenName,
            label: "Verification Token",
            guide: (held) => ({
              instructions: "Open Events & Callbacks → Encryption Strategy and copy the Verification Token.",
              url: eventPage(kind, idOf(held)),
            }),
            // The first signed event says whether it is right; nothing can be asked of the platform before.
            check: async () => undefined,
            capture,
          }),
        ]
      : []),
  ];

  return {
    values,
    async finish(held) {
      const appId = idOf(held);
      const findings = await scopesOf(held);
      const ready = findings.lines.length === 0;
      const then = ready ? "" : "after the permission work above, ";
      const publish = `CREATE + PUBLISH a version: ${apiBase}/app/${encodeURIComponent(appId)}/version`;
      const lines = [...findings.lines];
      if (way === "connection") {
        // A Feishu app made by scan-to-create is on a long connection already, with the event subscribed (measured).
        lines.push(
          kind === "feishu"
            ? `${then}${publish}`
            : `in Events & Callbacks choose long connection and make sure ${FEISHU_MESSAGE_RECEIVE_EVENT} is subscribed ` +
                `(no Verification Token, Request URL or tunnel is needed): ${eventPage(kind, appId)}; then ${then}${publish}`,
        );
      } else if (token === "captured") {
        lines.push(`the switch to webhook mode takes effect on publish: ${then}${publish} (self-approved)`);
      } else if (token === "pasted") {
        lines.push(
          `the instance sets the Subscription mode and Request URL itself when the app holds ${FEISHU_APP_CONFIG_SCOPE}; ` +
            `otherwise choose webhook in Events & Callbacks and set the Request URL to ` +
            `${publicUrl ?? "https://<where it is served>"}/${kind}, then ${then}${publish}`,
        );
      }
      return lines;
    },
  };
}

export const feishuSetup: ChannelSetup = (context) => {
  const { way, dev } = context;
  return feishuEngine(
    "feishu",
    {
      kind: "create",
      names: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
      async create(person) {
        say("creating the Feishu app (confirm in the app)…");
        const app = await registerFeishuApp({
          name: dev ? "{user}'s agent" : "{user}'s production agent",
          desc: "Served by fastagent",
          // The agent template alone is not enough to SERVE, nor to hear a group (see feishuAppAddons).
          addons: feishuAppAddons(way),
          onVerificationUrl: ({ url, expiresInS }) =>
            person.waitsOn(
              url,
              "confirm the new Feishu app (in a browser, or in Feishu, or as a QR code)",
              Date.now() + expiresInS * 1000,
            ),
        });
        person.carriesOn();
        say(`app created: ${app.appId}${app.tenantBrand ? ` (${app.tenantBrand} tenant)` : ""}`);
        // A cross-brand confirmation should be impossible (each confirm page refuses the other brand's code).
        if (app.tenantBrand && app.tenantBrand !== "feishu") {
          throw new Error(
            `the confirming account is a ${app.tenantBrand} tenant, but this is feishu: run \`fastagent channels setup ${app.tenantBrand}\` instead`,
          );
        }
        return { FEISHU_APP_ID: app.appId, FEISHU_APP_SECRET: app.appSecret };
      },
    },
    context,
  );
};
