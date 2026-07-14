/**
 * One-click app creation ("scan to create") — the OAuth 2.0 Device Authorization Grant (RFC 8628)
 * flow the platform provides for agent apps: `begin` returns a one-time verification URL the user
 * opens in Feishu/Lark and confirms (the platform pre-configures the agent app template: bot
 * capability, messaging scopes, event subscriptions); polling returns the new app's credentials.
 *
 * Hand-rolled on fetch, no SDK: the wire protocol is two form-encoded POSTs to the accounts endpoint
 * plus RFC 8628's polling error dance — shared verbatim by all four official SDKs (node/python/java/go),
 * which makes it a de-facto stable surface even though only the SDKs document it. Provenance:
 * larksuite/node-sdk `scene/registration` (registerApp). If the platform ever moves this behind
 * something non-trivial (signed payloads, websockets), adopt the official SDK instead of chasing it —
 * the same tripwire as feishu-api.ts.
 *
 * The scanning user's tenant decides the brand: a Lark-tenant user flips polling to the Lark accounts
 * domain mid-flow (`tenant_brand: "lark"`), and the result carries the brand so the caller can point
 * everything else (API origin) at the right cloud.
 */

import { gzipSync } from "node:zlib";

/** Feishu accounts endpoint (the flow starts here for every user; a Lark-tenant scan switches over). */
const FEISHU_ACCOUNTS = "https://accounts.feishu.cn";
const LARK_ACCOUNTS = "https://accounts.larksuite.com";
const ENDPOINT = "/oauth/v1/app/registration";

/** Per-attempt timeout for one registration POST — small form/JSON round-trips. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Additive app config carried on the confirm-page URL (`addons` query param): extra scopes/events
 * merged ON TOP of the platform's agent template — base permissions can never be removed. Shape and
 * encoding (JSON → gzip → base64url) follow the official SDKs (provenance: node-sdk
 * scene/registration); item names unknown to the platform catalog are silently dropped by the page.
 */
export interface FeishuAppAddons {
  scopes?: { tenant?: string[]; user?: string[] };
  events?: { items?: { tenant?: string[]; user?: string[] } };
  callbacks?: { items?: string[] };
}

/** JSON → gzip → base64url — the platform's fixed addons encoding. */
function encodeAddons(addons: FeishuAppAddons): string {
  return gzipSync(Buffer.from(JSON.stringify(addons), "utf8"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface RegisterFeishuAppOptions {
  /** Pre-filled app name shown on the confirm page (`{user}` expands to the scanning user's name). */
  name?: string;
  /** Pre-filled app description. */
  desc?: string;
  /** Extra scopes/events merged onto the agent template at creation (see {@link FeishuAppAddons}). */
  addons?: FeishuAppAddons;
  /** Called once the one-time verification URL is ready — print it / render it as a QR code. */
  onVerificationUrl: (info: { url: string; expiresInS: number }) => void;
  /** Cancel the polling. */
  signal?: AbortSignal;
  /** Accounts origins, for tests. */
  accountsBaseUrl?: string;
  larkAccountsBaseUrl?: string;
}

export interface RegisteredFeishuApp {
  appId: string;
  appSecret: string;
  /** "feishu" | "lark" — which cloud the scanning user's tenant lives on (drives the API origin). */
  tenantBrand?: string;
  /** The scanning user's open_id, when the platform returns it. */
  openId?: string;
}

interface RegistrationResponse {
  device_code?: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
  client_id?: string;
  client_secret?: string;
  user_info?: { open_id?: string; tenant_brand?: string };
  error?: string;
  error_description?: string;
}

/** RFC 8628 device-flow states whose non-2xx JSON bodies belong to the polling state machine. */
const DEVICE_FLOW_ERRORS = new Set(["authorization_pending", "slow_down", "access_denied", "expired_token"]);

/** One registration POST (form-encoded). RFC 8628 delivers polling states (authorization_pending,
 *  slow_down, …) as HTTP 400 with a JSON body — those parse as data, not as transport failures. */
async function post(baseUrl: string, params: Record<string, string>): Promise<RegistrationResponse> {
  let res: Response;
  let raw: string;
  try {
    res = await fetch(`${baseUrl}${ENDPOINT}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await res.text();
  } catch (e) {
    throw new Error(`feishu app registration: ${String(e)}`, { cause: e });
  }
  let data: RegistrationResponse;
  try {
    data = JSON.parse(raw) as RegistrationResponse;
  } catch {
    throw new Error(`feishu app registration failed: ${res.status} — response was not the expected JSON`);
  }
  if (!res.ok && !(data.error && DEVICE_FLOW_ERRORS.has(data.error))) {
    const diagnostic = data.error
      ? `${data.error}${data.error_description ? ` — ${data.error_description}` : ""}`
      : raw.trim().slice(0, 500) || "empty response";
    throw new Error(`feishu app registration failed: HTTP ${res.status} — ${diagnostic}`);
  }
  return data;
}

/** Sleep on the GLOBAL timer (not `node:timers/promises`) so tests can drive it with fake timers. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the scan-to-create flow (module header): begin → hand the verification URL to the caller →
 * poll until the user confirms. Resolves with the new app's credentials; rejects on denial, expiry,
 * abort, or a transport failure — every rejection is a plain Error whose message says what to do.
 */
export async function registerFeishuApp(options: RegisterFeishuAppOptions): Promise<RegisteredFeishuApp> {
  const feishuBase = options.accountsBaseUrl ?? FEISHU_ACCOUNTS;
  const larkBase = options.larkAccountsBaseUrl ?? LARK_ACCOUNTS;

  const begin = await post(feishuBase, {
    action: "begin",
    archetype: "PersonalAgent", // the platform's agent-app template: bot + messaging scopes + events pre-configured
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  if (!begin.device_code || !begin.verification_uri_complete) {
    throw new Error(
      `feishu app registration: begin returned no device code (${begin.error ?? "unexpected response"}${begin.error_description ? `: ${begin.error_description}` : ""})`,
    );
  }

  const url = new URL(begin.verification_uri_complete);
  url.searchParams.set("from", "sdk");
  url.searchParams.set("tp", "sdk");
  url.searchParams.set("source", "fastagent");
  if (options.name !== undefined) url.searchParams.set("name", options.name);
  if (options.desc !== undefined) url.searchParams.set("desc", options.desc);
  if (options.addons !== undefined) url.searchParams.set("addons", encodeAddons(options.addons));
  const expiresInS = begin.expires_in ?? 600;
  options.onVerificationUrl({ url: url.toString(), expiresInS });

  let pollBase = feishuBase;
  let switched = false;
  let intervalMs = (begin.interval ?? 5) * 1000;
  const deadline = Date.now() + expiresInS * 1000;
  for (;;) {
    if (options.signal?.aborted) throw new Error("feishu app registration was aborted");
    if (Date.now() >= deadline) {
      throw new Error(
        "feishu app registration: the verification link expired before anyone confirmed — re-run to get a fresh one",
      );
    }
    const poll = await post(pollBase, { action: "poll", device_code: begin.device_code });

    // A Lark-tenant user: the flow continues on the Lark accounts domain (once), same device code.
    if (poll.user_info?.tenant_brand === "lark" && !switched) {
      switched = true;
      pollBase = larkBase;
      continue;
    }
    if (poll.client_id && poll.client_secret) {
      return {
        appId: poll.client_id,
        appSecret: poll.client_secret,
        tenantBrand: poll.user_info?.tenant_brand,
        openId: poll.user_info?.open_id,
      };
    }
    switch (poll.error) {
      case "authorization_pending":
        break; // the user has not confirmed yet — keep polling
      case "slow_down":
        intervalMs += 5000; // RFC 8628: back off and keep polling
        break;
      case "access_denied":
        throw new Error("feishu app registration: the user declined the authorization");
      case "expired_token":
        throw new Error("feishu app registration: the verification link expired — re-run to get a fresh one");
      default:
        if (poll.error) {
          throw new Error(
            `feishu app registration failed: ${poll.error}${poll.error_description ? ` — ${poll.error_description}` : ""}`,
          );
        }
        break; // no error, no credentials — treat as pending
    }
    await wait(intervalMs);
  }
}
