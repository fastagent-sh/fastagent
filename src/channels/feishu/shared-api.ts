/** The mounted channel and proactive tools share credentials, token cache, gateway and retry policy. */
import { resolveStateRoot } from "../../paths.ts";
import { roomThreads } from "../kit/room-threads.ts";
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

function cloudTransport(cwd: string, kind: FeishuCloudKind): FeishuTransport {
  // A tool's working directory is its agent's directory, so the agent's state root follows from it.
  const stateRoot = resolveStateRoot(cwd);
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

/** Resolve the Feishu transport for a tool's agent directory (`ctx.cwd`). */
export function feishuTransport(cwd: string): FeishuTransport {
  return cloudTransport(cwd, "feishu");
}

/** Resolve the Lark transport for a tool's agent directory (`ctx.cwd`). */
export function larkTransport(cwd: string): FeishuTransport {
  return cloudTransport(cwd, "lark");
}

/**
 * The threads of the group chat a tool's turn was asked in, and only those (`kit/room-threads.ts`): `list()` its recent
 * threads, `read(threadId)` one of them. Throws outside a Feishu group turn served by this process.
 */
export function feishuThreads(ctx: Parameters<typeof roomThreads>[1]): ReturnType<typeof roomThreads> {
  return roomThreads("feishu", ctx);
}

/** {@link feishuThreads}, for a Lark group turn. */
export function larkThreads(ctx: Parameters<typeof roomThreads>[1]): ReturnType<typeof roomThreads> {
  return roomThreads("lark", ctx);
}
