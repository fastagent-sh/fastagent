/** The mounted channel and proactive tools share credentials, token cache, gateway and retry policy. */
import { resolveStateRoot } from "../../paths.ts";
import { cloudFor, type FeishuCloudKind } from "./cloud.ts";
import { createFeishuApi, type FeishuApi } from "./feishu-api.ts";

/** The delivery methods a proactive sender needs. */
export type FeishuTransport = Pick<FeishuApi, "sendText" | "sendMessage">;

const byKind: Record<FeishuCloudKind, Map<string, FeishuApi>> = {
  feishu: new Map(),
  lark: new Map(),
};

/** A remount replaces the transport; separate clouds can share one agent state root. */
export function registerFeishuApi(stateRoot: string, kind: FeishuCloudKind, api: FeishuApi): void {
  byKind[kind].set(stateRoot, api);
}

function cloudTransport(agentDir: string, kind: FeishuCloudKind): FeishuTransport {
  // The agent's state root, where the mounted channel registered its transport.
  const stateRoot = resolveStateRoot(agentDir);
  const transports = byKind[kind];
  let api = transports.get(stateRoot);
  if (!api) {
    // fire/invoke/tool do not mount channels, so their credentials come from the agent's environment.
    const { apiBase, envPrefix } = cloudFor(kind);
    const appId = process.env[`${envPrefix}_APP_ID`];
    const appSecret = process.env[`${envPrefix}_APP_SECRET`];
    if (!appId || !appSecret) {
      throw new Error(`${envPrefix}_APP_ID / ${envPrefix}_APP_SECRET are not set and no ${kind} channel is mounted`);
    }
    api = createFeishuApi({ kind, baseUrl: apiBase, appId, appSecret });
    transports.set(stateRoot, api);
  }
  return api;
}

/** Resolve the Feishu transport for a tool's agent directory (`ctx.agentDir`). */
export function feishuTransport(agentDir: string): FeishuTransport {
  return cloudTransport(agentDir, "feishu");
}

/** Resolve the Lark transport for a tool's agent directory (`ctx.agentDir`). */
export function larkTransport(agentDir: string): FeishuTransport {
  return cloudTransport(agentDir, "lark");
}
