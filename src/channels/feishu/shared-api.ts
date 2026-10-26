/**
 * The mounted channel and proactive tools share credentials, token cache, gateway and retry policy: one transport per
 * app a process holds, found by the app id both hold.
 */
import { roomThreads } from "../kit/room-threads.ts";
import { cloudFor, type FeishuCloudKind } from "./cloud.ts";
import { createFeishuApi, type FeishuApi } from "./feishu-api.ts";

/** The delivery methods a proactive sender needs. */
export type FeishuTransport = Pick<FeishuApi, "sendText" | "sendMessage">;

/** The app a transport signs in as. */
export interface FeishuAppCredentials {
  appId: string;
  appSecret: string;
}

const byKind: Record<FeishuCloudKind, Map<string, FeishuApi>> = {
  feishu: new Map(),
  lark: new Map(),
};

/** A remount replaces the transport: the channel's is the authoritative one for its app. */
export function registerFeishuApi(appId: string, kind: FeishuCloudKind, api: FeishuApi): void {
  byKind[kind].set(appId, api);
}

function cloudTransport({ appId, appSecret }: FeishuAppCredentials, kind: FeishuCloudKind): FeishuTransport {
  const transports = byKind[kind];
  let api = transports.get(appId);
  if (!api) {
    api = createFeishuApi({ kind, baseUrl: cloudFor(kind).apiBase, appId, appSecret });
    transports.set(appId, api);
  }
  return api;
}

/** The Feishu transport of an app: its mounted channel's, or the app's own when none is mounted. */
export function feishuTransport(app: FeishuAppCredentials): FeishuTransport {
  return cloudTransport(app, "feishu");
}

/** The Lark transport of an app: its mounted channel's, or the app's own when none is mounted. */
export function larkTransport(app: FeishuAppCredentials): FeishuTransport {
  return cloudTransport(app, "lark");
}

/**
 * The threads of the group chat the message running in `sessionId` was asked in, and only those
 * (`kit/room-threads.ts`): `list()` its recent threads, `read(threadId)` one of them. Throws outside a Feishu group
 * turn served by this process.
 */
export function feishuThreads(sessionId: string | undefined): ReturnType<typeof roomThreads> {
  return roomThreads("feishu", sessionId);
}

/** {@link feishuThreads}, for a Lark group turn. */
export function larkThreads(sessionId: string | undefined): ReturnType<typeof roomThreads> {
  return roomThreads("lark", sessionId);
}
