/**
 * Auth resolution for the pi engine (the harness's `getApiKeyAndHeaders` injection).
 *
 * This is **reusable pi engine wiring**, hence it lives in engines/pi — not in examples.
 * Process-level global side effects (e.g. the undici proxy dispatcher) do NOT belong
 * here: those are the application entry point's responsibility.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getEnvApiKey } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";

export type Auth = { apiKey: string; headers?: Record<string, string> } | undefined;
export type AuthResolver = (model: Model<any>) => Promise<Auth>;

/** pi's local credentials file (written by the pi CLI). */
export const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

/** Resolve from environment variables (e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY). */
export const envAuth: AuthResolver = (model) => {
  const apiKey = getEnvApiKey(model.provider);
  return Promise.resolve(apiKey ? { apiKey } : undefined);
};

/**
 * Resolve from pi's OAuth credentials file (`~/.pi/agent/auth.json`, consuming
 * coding-plan tokens). The access token is returned directly as apiKey — pi-ai's
 * providers auto-detect OAuth tokens (anthropic `sk-ant-oat` / openai-codex JWT)
 * and set the Bearer auth plus required request headers themselves.
 *
 * Note: **no token refresh** (expired → undefined; the user re-logs-in via pi).
 * Coupled to the pi CLI credentials format — an out-of-the-box convenience, not a
 * core contract.
 */
export function piOAuthAuth(authPath: string = PI_AUTH_PATH): AuthResolver {
  return (model) => {
    let raw: string;
    try {
      raw = readFileSync(authPath, "utf8");
    } catch (error) {
      // Missing file = not configured (normal). Anything else must be visible.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[fastagent] cannot read ${authPath}: ${(error as Error).message}`);
      }
      return Promise.resolve(undefined);
    }
    let creds: Record<string, { type?: string; access?: unknown; expires?: unknown }>;
    try {
      creds = JSON.parse(raw);
    } catch {
      // Corrupt credentials are an anomaly, not "not configured" — warn so the
      // root cause is diagnosable instead of a confusing downstream auth failure.
      console.warn(`[fastagent] corrupt auth file ${authPath}; run pi to re-login`);
      return Promise.resolve(undefined);
    }
    const cred = creds[model.provider];
    if (
      cred?.type === "oauth" &&
      typeof cred.access === "string" &&
      !(typeof cred.expires === "number" && cred.expires < Date.now())
    ) {
      return Promise.resolve({ apiKey: cred.access });
    }
    return Promise.resolve(undefined);
  };
}

/** Default resolution: try pi OAuth (coding plan) first, then fall back to env vars. */
export function resolvePiAuth(authPath?: string): AuthResolver {
  const oauth = piOAuthAuth(authPath);
  return async (model) => (await oauth(model)) ?? envAuth(model);
}
