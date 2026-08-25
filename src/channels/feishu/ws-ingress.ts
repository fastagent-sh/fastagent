import type { LongConnection } from "../../channel.ts";
import { log } from "../../log.ts";
import type { FeishuCloudKind } from "./cloud.ts";
import type { FeishuMessageEvent } from "./parse.ts";

interface FeishuWsClient {
  start(): Promise<void>;
  close(): void;
}

interface FeishuWsClientCallbacks {
  onReady(): void;
  onError(error: Error): void;
  onReconnecting(): void;
  onReconnected(): void;
  onEvent(event: FeishuMessageEvent): void | Promise<void>;
}

export type CreateFeishuWsClient = (callbacks: FeishuWsClientCallbacks) => FeishuWsClient | Promise<FeishuWsClient>;

export interface FeishuWsConnectionOptions {
  kind: FeishuCloudKind;
  appId: string;
  appSecret: string;
  domain: string;
  onEvent(event: FeishuMessageEvent): void | Promise<void>;
  /** Internal SDK seam for deterministic tests. */
  createClient?: CreateFeishuWsClient;
}

function sdkLogger(label: string) {
  return {
    error: (...parts: unknown[]) => log.error(`${label} ${parts.map(String).join(" ")}`),
    warn: (...parts: unknown[]) => log.warn(`${label} ${parts.map(String).join(" ")}`),
    info: (...parts: unknown[]) => log.info(`${label} ${parts.map(String).join(" ")}`),
    debug: (...parts: unknown[]) => log.debug(`${label} ${parts.map(String).join(" ")}`),
    trace: (...parts: unknown[]) => log.debug(`${label} ${parts.map(String).join(" ")}`),
  };
}

async function productionClient(
  options: FeishuWsConnectionOptions,
  callbacks: FeishuWsClientCallbacks,
): Promise<FeishuWsClient> {
  // Webhook-only users stay on the lightweight fetch path; load the proprietary-protocol SDK only
  // when a WebSocket connection is actually opened.
  const { EventDispatcher, LoggerLevel, WSClient } = await import("@larksuiteoapi/node-sdk");
  const label = `[${options.kind}:ws]`;
  const logger = sdkLogger(label);
  const eventDispatcher = new EventDispatcher({ logger, loggerLevel: LoggerLevel.warn }).register({
    "im.message.receive_v1": callbacks.onEvent,
  });
  const client = new WSClient({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domain,
    logger,
    loggerLevel: LoggerLevel.warn,
    autoReconnect: true,
    source: "fastagent",
    handshakeTimeoutMs: 15_000,
    onReady: callbacks.onReady,
    onError: callbacks.onError,
    onReconnecting: callbacks.onReconnecting,
    onReconnected: callbacks.onReconnected,
  });
  return {
    start: () => client.start({ eventDispatcher }),
    close: () => client.close(),
  };
}

/** Open Feishu/Lark's official-SDK WebSocket connection. The SDK ACKs only after `onEvent` settles;
 * a persistence throw therefore becomes a 500 response frame and the platform re-pushes the event. */
export function connectFeishuWs(options: FeishuWsConnectionOptions, signal: AbortSignal): LongConnection {
  const label = `[${options.kind}:ws]`;
  // The SDK only logs + returns for this case (no onError), which would leave readiness pending forever.
  if (!/^cli_[0-9a-fA-F]{16}$/.test(options.appId)) {
    throw new Error(`${options.kind} websocket requires an App ID shaped like cli_<16 hex characters>`);
  }

  let readySettled = false;
  let closedSettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const fail = (error: unknown): void => {
    if (signal.aborted || closedSettled) return;
    // Settle-then-close: closedSettled first makes a close()-triggered SDK callback re-entry a no-op.
    closedSettled = true;
    // Terminal failure must release the transport here: the abort listener's close() no-ops once
    // closedSettled is set, and only close() destroys SDK-held resources (e.g. its cache sweep timer).
    if (client) closeClient(client);
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!readySettled) {
      readySettled = true;
      rejectReady(failure);
    }
    rejectClosed(failure);
  };
  const createClient = options.createClient ?? ((callbacks) => productionClient(options, callbacks));
  let client: FeishuWsClient | undefined;
  const callbacks: FeishuWsClientCallbacks = {
    onReady() {
      if (readySettled || signal.aborted) return;
      readySettled = true;
      log.info(`${label} connected`);
      resolveReady();
    },
    onError(error) {
      fail(
        new Error(
          `${error.message} — check that Events & Callbacks uses long connection and the published app version includes im.message.receive_v1`,
        ),
      );
    },
    onReconnecting() {
      if (!signal.aborted) log.warn(`${label} disconnected — reconnecting…`);
    },
    onReconnected() {
      if (!signal.aborted) log.info(`${label} reconnected`);
    },
    onEvent: options.onEvent,
  };
  const closeClient = (target: FeishuWsClient): void => {
    try {
      target.close();
    } catch (error) {
      log.warn(`${label} close failed: ${String(error)}`);
    }
  };
  const close = (): void => {
    if (closedSettled) return;
    closedSettled = true; // before closeClient, so a callback re-entry from close() is a no-op
    if (client) closeClient(client);
    if (!readySettled) {
      // Abort before the first connection: `ready` still settles, and resolution here means
      // cancellation, not readiness (the LongConnection contract; serve skips ready-side effects).
      readySettled = true;
      resolveReady();
    }
    resolveClosed();
  };
  if (signal.aborted) {
    close();
    return { ready, closed };
  }
  signal.addEventListener("abort", close, { once: true });
  void Promise.resolve(createClient(callbacks)).then((created) => {
    client = created;
    if (signal.aborted || closedSettled) {
      closeClient(created);
      return;
    }
    void created.start().catch(fail);
  }, fail);
  return { ready, closed };
}
