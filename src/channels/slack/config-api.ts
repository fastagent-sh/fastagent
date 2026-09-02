import type { SlackAppManifest } from "./manifest.ts";

const SLACK_API = "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 30_000;

interface SlackErrorShape {
  ok?: boolean;
  error?: string;
  errors?: { message?: string; pointer?: string }[];
}

export class SlackConfigApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(method: string, status: number, data: SlackErrorShape, fallback: string) {
    const code = data.error ?? fallback;
    const fields = data.errors
      ?.map((error) => `${error.pointer ?? "manifest"}: ${error.message ?? "invalid"}`)
      .join("; ");
    super(`Slack ${method} failed: ${code}${fields ? ` — ${fields}` : ""}`);
    this.name = "SlackConfigApiError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Whether a manifest call failed because Slack could not verify the `request_url` it carries — the
 * platform's own readiness verdict on a freshly minted public URL, and the reason no local `/health`
 * poll precedes these calls (#421). Slack validates the manifest BEFORE acting on it, so a create that
 * ends here created nothing and is safe to retry.
 */
export function isSlackRequestUrlUnverified(error: unknown): boolean {
  return /request_url|verify_request_url|failed to verify/i.test(String(error));
}

async function slackJson<T>(
  method: string,
  body: Record<string, unknown>,
  options: { token?: string; apiBaseUrl?: string; fetch?: typeof fetch } = {},
): Promise<T> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  let response: Response;
  let raw: string;
  try {
    response = await fetchFn(`${options.apiBaseUrl ?? SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await response.text();
  } catch (error) {
    throw new Error(`Slack ${method} request failed before receiving a response`, { cause: error });
  }
  let data: SlackErrorShape & T;
  try {
    data = JSON.parse(raw) as SlackErrorShape & T;
  } catch {
    throw new Error(`Slack ${method} failed: HTTP ${response.status} returned non-JSON`);
  }
  if (!response.ok || data.ok !== true) {
    throw new SlackConfigApiError(method, response.status, data, raw.trim().slice(0, 200) || "unknown_error");
  }
  return data;
}

export interface SlackAppCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  oauthAuthorizeUrl?: string;
}

interface CreateManifestResponse {
  ok: true;
  app_id?: string;
  oauth_authorize_url?: string;
  credentials?: {
    client_id?: string;
    client_secret?: string;
    signing_secret?: string;
  };
}

/** Create is intentionally single-attempt: an ambiguous response may already have created the app. */
export async function createSlackApp(
  configToken: string,
  manifest: SlackAppManifest,
  options: { apiBaseUrl?: string; fetch?: typeof fetch } = {},
): Promise<SlackAppCredentials> {
  const data = await slackJson<CreateManifestResponse>(
    "apps.manifest.create",
    { manifest: JSON.stringify(manifest) },
    { ...options, token: configToken },
  );
  const credentials = data.credentials;
  if (!data.app_id || !credentials?.client_id || !credentials.client_secret || !credentials.signing_secret) {
    throw new Error("Slack apps.manifest.create succeeded but returned incomplete app credentials");
  }
  return {
    appId: data.app_id,
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    signingSecret: credentials.signing_secret,
    oauthAuthorizeUrl: data.oauth_authorize_url,
  };
}

export async function updateSlackAppManifest(
  configToken: string,
  appId: string,
  manifest: SlackAppManifest,
  options: { apiBaseUrl?: string; fetch?: typeof fetch } = {},
): Promise<void> {
  await slackJson<{ ok: true }>(
    "apps.manifest.update",
    { app_id: appId, manifest: JSON.stringify(manifest) },
    { ...options, token: configToken },
  );
}

export interface RotatedSlackConfigToken {
  token: string;
  refreshToken: string;
  expiresAt: number;
  teamId?: string;
}

export async function rotateSlackConfigToken(
  refreshToken: string,
  options: { apiBaseUrl?: string; fetch?: typeof fetch } = {},
): Promise<RotatedSlackConfigToken> {
  const data = await slackJson<{
    ok: true;
    token?: string;
    refresh_token?: string;
    exp?: number;
    team_id?: string;
  }>("tooling.tokens.rotate", { refresh_token: refreshToken }, options);
  if (!data.token || !data.refresh_token || typeof data.exp !== "number") {
    throw new Error("Slack tooling.tokens.rotate succeeded but returned incomplete token credentials");
  }
  return {
    token: data.token,
    refreshToken: data.refresh_token,
    expiresAt: data.exp * 1000,
    teamId: data.team_id,
  };
}

/**
 * One installed app's runtime credentials, however they were obtained. The rotation pair is OPTIONAL
 * because a console install (`--manual`) issues a static bot token instead — the channel accepts both
 * (bot-auth.ts serves the static token when the rotation fields are absent).
 */
export interface SlackOAuthResult {
  botToken: string;
  botRefreshToken?: string;
  botTokenExpiresAt?: number;
  /** Which app the token belongs to, when the installer could observe it (`oauth.v2.access` always
   *  says; `auth.test` may not). Absent means "not observed", never "the expected one". */
  appId?: string;
  teamId: string;
  teamName?: string;
  botUserId?: string;
  scopes: string[];
}

/**
 * Who a bot token belongs to. The one call that can tell a real pasted token from a typo, which is why
 * the manual install path ends with it rather than trusting what came back from the terminal.
 */
export async function slackAuthTest(
  botToken: string,
  options: { apiBaseUrl?: string; fetch?: typeof fetch } = {},
): Promise<{ appId?: string; teamId: string; teamName?: string; botUserId?: string }> {
  const data = await slackJson<{
    ok: true;
    app_id?: string;
    team_id?: string;
    team?: string;
    bot_id?: string;
    user_id?: string;
  }>("auth.test", {}, { ...options, token: botToken });
  if (!data.team_id) throw new Error("Slack auth.test accepted the token but returned no workspace identity");
  return { appId: data.app_id, teamId: data.team_id, teamName: data.team, botUserId: data.user_id };
}

function slackOAuthFailure(status: number, code: unknown): Error {
  const reason = (() => {
    switch (code) {
      case "bad_client_secret":
        return "Slack rejected the app client secret";
      case "invalid_client_id":
        return "Slack rejected the app client ID";
      case "bad_redirect_uri":
      case "invalid_redirect_uri":
        return "Slack rejected the temporary OAuth redirect URL";
      case "invalid_code":
        return "Slack rejected the authorization code";
      case "code_already_used":
        return "the Slack authorization code was already used";
      case "access_denied":
        return "the Slack installation was not approved";
      default:
        return "Slack rejected the OAuth exchange";
    }
  })();
  return new Error(`${reason} (HTTP ${status}); re-run fastagent add slack to resume installation`);
}

export async function exchangeSlackOAuthCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUrl: string },
  options: { apiBaseUrl?: string; fetch?: typeof fetch } = {},
): Promise<SlackOAuthResult> {
  const authorization = Buffer.from(`${input.clientId}:${input.clientSecret}`, "utf8").toString("base64");
  const fetchFn = options.fetch ?? globalThis.fetch;
  let response: Response;
  let raw: string;
  try {
    response = await fetchFn(`${options.apiBaseUrl ?? SLACK_API}/oauth.v2.access`, {
      method: "POST",
      headers: {
        authorization: `Basic ${authorization}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: input.code, redirect_uri: input.redirectUrl }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await response.text();
  } catch (error) {
    throw new Error("Slack oauth.v2.access request failed before receiving a response", { cause: error });
  }
  let data: SlackErrorShape & {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    app_id?: string;
    scope?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string };
  };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    throw new Error(`Slack oauth.v2.access failed: HTTP ${response.status} returned non-JSON`);
  }
  if (!response.ok || data.ok !== true) throw slackOAuthFailure(response.status, data.error);
  if (
    !data.access_token ||
    !data.refresh_token ||
    typeof data.expires_in !== "number" ||
    !data.app_id ||
    !data.team?.id
  ) {
    throw new Error("Slack oauth.v2.access succeeded but returned incomplete rotating bot credentials/app identity");
  }
  return {
    botToken: data.access_token,
    botRefreshToken: data.refresh_token,
    botTokenExpiresAt: Date.now() + data.expires_in * 1_000,
    appId: data.app_id,
    teamId: data.team.id,
    teamName: data.team.name,
    botUserId: data.bot_user_id,
    scopes: (data.scope ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  };
}
