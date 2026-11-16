/**
 * What a Feishu or Lark app's setup asks for (kit/setup.ts). The two share one engine: the app's credentials come
 * first (Feishu creates the app by scan-to-create and keeps what it returns; Lark's person creates it in its console and
 * pastes them). What is left to the person is the permission work and the publish, which depend on what the platform
 * says about the app.
 */
import type { ChannelSetup, HeldValues, SetupValue } from "@fastagent-sh/client/kit/setup";
import { type FeishuCloudKind, cloudFor } from "./cloud.ts";
import { type FeishuApi, createFeishuApi } from "./feishu-api.ts";
import { registerFeishuApp } from "./register-app.ts";
import {
  FEISHU_AGENT_SCOPES,
  FEISHU_MESSAGE_RECEIVE_EVENT,
  type FeishuScopeRequest,
  feishuAppAddons,
  feishuScopeRequestUrl,
  scopeSatisfied,
} from "./setup-mode.ts";

const say = (message: string): void => console.error(`[fastagent] ${message}`);

/** The page of an app where its subscription mode is chosen. */
const eventPage = (kind: FeishuCloudKind, appId: string): string =>
  `${cloudFor(kind).apiBase}/app/${encodeURIComponent(appId)}/event?tab=safe`;

/**
 * What the app holds of what an agent app needs ({@link FEISHU_AGENT_SCOPES}). A created app asks for them on its
 * confirm page, and a tenant may still withhold some (its approval policy, or an app made by hand): those are NAMED,
 * with what each one costs, and the console page that requests them is linked pre-filled. Answers what to tell the
 * person: nothing when the app holds everything it needs.
 */
async function agentScopes(
  kind: FeishuCloudKind,
  appId: string,
  api: Pick<FeishuApi, "listAppScopes">,
): Promise<string[]> {
  const apiBase = cloudFor(kind).apiBase;
  const requested = FEISHU_AGENT_SCOPES.map((entry) => entry.request);
  let scopes: Awaited<ReturnType<FeishuApi["listAppScopes"]>>;
  try {
    scopes = await api.listAppScopes();
  } catch (error) {
    return [
      `could not read the ${kind} app's permissions (${String(error)}): make sure it holds ${requested.join(", ")} ` +
        `before publishing: ${feishuScopeRequestUrl(apiBase, appId, requested)}`,
    ];
  }
  // A user-type entry is not the tenant scope the app acts with.
  const tenant = scopes.filter((scope) => scope.type === undefined || scope.type === "tenant");
  const granted = (name: string): boolean => tenant.some((scope) => scope.name === name && scope.grantStatus === 1);
  const missing = FEISHU_AGENT_SCOPES.filter((entry) => !scopeSatisfied(entry, granted));
  if (missing.length === 0) {
    say(`${kind} app permissions: ${requested.join(", ")} granted`);
    return [];
  }
  // "Not granted", not "not requested": the list omits a scope still under review (measured), so the two look alike.
  const describe = (entry: FeishuScopeRequest): string => `\n  ${entry.request}: without it ${entry.withoutIt}`;
  const url = feishuScopeRequestUrl(
    apiBase,
    appId,
    missing.map((entry) => entry.request),
  );
  return [
    `the ${kind} app is not granted:${missing.map(describe).join("")}\n` +
      `Tick and enable them at ${url} (one may already be awaiting a tenant admin's approval), before publishing`,
  ];
}

/** The setup of a Feishu or Lark app whose credentials are `credentials`. */
export function feishuEngine(kind: FeishuCloudKind, credentials: SetupValue): ReturnType<ChannelSetup> {
  const { envPrefix, apiBase } = cloudFor(kind);
  const idName = `${envPrefix}_APP_ID`;
  const idOf = (held: HeldValues): string => held.get(idName) as string;
  const apiOf = (held: HeldValues): FeishuApi =>
    createFeishuApi({
      kind,
      baseUrl: apiBase,
      appId: idOf(held),
      appSecret: held.get(`${envPrefix}_APP_SECRET`) as string,
    });
  return {
    values: [credentials],
    async finish(held) {
      const appId = idOf(held);
      const findings = await agentScopes(kind, appId, apiOf(held));
      const ready = findings.length === 0;
      const then = ready ? "" : "after the permission work above, ";
      const publish = `CREATE + PUBLISH a version: ${apiBase}/app/${encodeURIComponent(appId)}/version`;
      // A Feishu app made by scan-to-create is on a long connection already, with the event subscribed (measured).
      return [
        ...findings,
        kind === "feishu"
          ? `${then}${publish}`
          : `in Events & Callbacks choose long connection and make sure ${FEISHU_MESSAGE_RECEIVE_EVENT} is subscribed: ` +
            `${eventPage(kind, appId)}; then ${then}${publish}`,
      ];
    },
  };
}

export const feishuSetup: ChannelSetup = ({ dev }) =>
  feishuEngine("feishu", {
    kind: "create",
    names: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
    async create(person) {
      say("creating the Feishu app (confirm in the app)…");
      const app = await registerFeishuApp({
        name: dev ? "{user}'s agent" : "{user}'s production agent",
        desc: "Served by fastagent",
        // The agent template alone is not enough to SERVE, nor to hear a group (see feishuAppAddons).
        addons: feishuAppAddons(),
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
  });
