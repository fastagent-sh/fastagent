/**
 * pi 引擎的认证解析(harness 的 `getApiKeyAndHeaders` 注入项)。
 *
 * 这些是**可复用的 pi 引擎接线**,故住在 engines/pi——而非 example。
 * 进程级全局副作用(如 undici 代理 dispatcher)不在此:那是应用入口的职责。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getEnvApiKey } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";

export type Auth = { apiKey: string; headers?: Record<string, string> } | undefined;
export type AuthResolver = (model: Model<any>) => Promise<Auth>;

/** pi 本地凭证文件(由 pi CLI 写入)。 */
export const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

/** 从环境变量解析(如 OPENAI_API_KEY / ANTHROPIC_API_KEY)。 */
export const envAuth: AuthResolver = (model) => {
  const apiKey = getEnvApiKey(model.provider);
  return Promise.resolve(apiKey ? { apiKey } : undefined);
};

/**
 * 从 pi 的 OAuth 凭证文件解析(`~/.pi/agent/auth.json`,消耗 coding plan token)。
 * 直接把 access token 当 apiKey 返回——pi-ai 的 provider 会自识别 OAuth token
 * (anthropic `sk-ant-oat` / openai-codex JWT)并设好 Bearer + 必要请求头。
 *
 * 注:**不刷新 token**(过期返回 undefined,提示用户重跑 pi 登录);耦合 pi CLI 的
 * 凭证文件格式,属"开箱即用"便利项,不是 core 契约。
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

/** 默认解析:先试 pi OAuth(coding plan),再退回环境变量。 */
export function resolvePiAuth(authPath?: string): AuthResolver {
  const oauth = piOAuthAuth(authPath);
  return async (model) => (await oauth(model)) ?? envAuth(model);
}
