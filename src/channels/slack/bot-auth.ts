/** Rotating Slack bot-token provider backed by owner-only channel state. */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const REFRESH_EARLY_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface SlackBotAuthState {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function isState(value: unknown): value is SlackBotAuthState {
  const state = value as Partial<SlackBotAuthState>;
  return (
    typeof state === "object" &&
    state !== null &&
    state.version === 1 &&
    typeof state.accessToken === "string" &&
    typeof state.refreshToken === "string" &&
    typeof state.expiresAt === "number"
  );
}

function load(path: string): SlackBotAuthState | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Slack bot auth state ${path} is unreadable: ${String(error)}`, { cause: error });
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isState(value)) throw new Error("unexpected shape/version");
    return value;
  } catch (error) {
    // A stale env refresh token may already have been consumed. Never hide corrupt rotating state by
    // falling back to it: recovery requires restoring the durable file or reinstalling the app.
    throw new Error(`Slack bot auth state ${path} is invalid: ${String(error)}`, { cause: error });
  }
}

function save(path: string, state: SlackBotAuthState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

async function refreshSlackBotToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  fetch: typeof fetch;
}): Promise<SlackBotAuthState> {
  const authorization = Buffer.from(`${input.clientId}:${input.clientSecret}`, "utf8").toString("base64");
  let lastError: unknown;
  // Slack keeps a short grace window for a just-consumed refresh token. One retry recovers the
  // committed-but-response-lost boundary without creating an unbounded refresh loop.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await input.fetch(`${input.apiBaseUrl}/oauth.v2.access`, {
        method: "POST",
        headers: {
          authorization: `Basic ${authorization}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: input.refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (
        !response.ok ||
        data.ok !== true ||
        !data.access_token ||
        !data.refresh_token ||
        typeof data.expires_in !== "number"
      ) {
        throw new Error(`Slack rejected bot-token refresh (HTTP ${response.status})`);
      }
      return {
        version: 1,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1_000,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Slack bot-token rotation failed; restore credentials or reinstall the app", { cause: lastError });
}

export interface SlackBotTokenProviderOptions {
  statePath: string;
  botToken: string;
  botRefreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  botTokenExpiresAt?: number;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

/** Latest local rotating credentials for `deploy --run`. The remote runtime still prefers its own
 * durable volume; this overlay prevents a locally consumed refresh token from being redeployed. */
export function readSlackBotAuthEnv(statePath: string): Record<string, string> {
  const state = load(statePath);
  return state
    ? {
        SLACK_BOT_TOKEN: state.accessToken,
        SLACK_BOT_REFRESH_TOKEN: state.refreshToken,
        SLACK_BOT_TOKEN_EXPIRES_AT: String(state.expiresAt),
      }
    : {};
}

/** Resolve the current bot token, refreshing once per process when it approaches expiry. */
export function createSlackBotTokenProvider(options: SlackBotTokenProviderOptions): () => Promise<string> {
  const rotatingFields = [options.botRefreshToken, options.clientId, options.clientSecret, options.botTokenExpiresAt];
  const rotating = rotatingFields.some((value) => value !== undefined);
  if (rotating && rotatingFields.some((value) => value === undefined || value === "")) {
    throw new Error(
      "Slack token rotation requires botRefreshToken, clientId, clientSecret, and botTokenExpiresAt together",
    );
  }
  if (rotating && (!Number.isFinite(options.botTokenExpiresAt) || (options.botTokenExpiresAt as number) <= 0)) {
    throw new Error("Slack botTokenExpiresAt must be a positive epoch-millisecond value");
  }
  if (!rotating) return async () => options.botToken;

  const configured = {
    version: 1,
    accessToken: options.botToken,
    refreshToken: options.botRefreshToken as string,
    expiresAt: options.botTokenExpiresAt as number,
  } satisfies SlackBotAuthState;
  const persisted = load(options.statePath);
  // Deploy may carry a newer pair from the owner machine onto an existing remote volume; ordinary
  // restarts carry the original stale env and therefore keep the newer persisted pair.
  let state = persisted && persisted.expiresAt >= configured.expiresAt ? persisted : configured;
  let refreshing: Promise<void> | undefined;

  return async () => {
    if (state.expiresAt > Date.now() + REFRESH_EARLY_MS) return state.accessToken;
    refreshing ??= refreshSlackBotToken({
      refreshToken: state.refreshToken,
      clientId: options.clientId as string,
      clientSecret: options.clientSecret as string,
      apiBaseUrl: (options.apiBaseUrl ?? "https://slack.com/api").replace(/\/$/, ""),
      fetch: options.fetch ?? globalThis.fetch,
    })
      .then((next) => {
        save(options.statePath, next);
        state = next;
      })
      .finally(() => {
        refreshing = undefined;
      });
    await refreshing;
    return state.accessToken;
  };
}
