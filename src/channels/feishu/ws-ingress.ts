import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

type CreateFeishuWsClient = (callbacks: FeishuWsClientCallbacks) => FeishuWsClient | Promise<FeishuWsClient>;

export interface FeishuWsConnectionOptions {
  kind: FeishuCloudKind;
  appId: string;
  appSecret: string;
  domain: string;
  onEvent(event: FeishuMessageEvent): void | Promise<void>;
  /** Directories whose own `node_modules` may hold the optional SDK when global/external fastagent cannot see it. */
  resolveFrom?: readonly string[];
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

function isMissingPackage(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
    if (typeof current !== "object") break;
    const code = (current as { code?: unknown }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
    const message = current instanceof Error ? current.message : String(current);
    if (message.includes("Cannot find package") || message.includes("Cannot find module")) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Load `@larksuiteoapi/node-sdk`, falling back to `resolveFrom` (the agent/program directory) so a global `fastagent`
 * binary or non-hoisted layout finds the SDK installed in the agent's own `node_modules`.
 */
async function loadFeishuSdk(resolveFrom: readonly string[] = []): Promise<typeof import("@larksuiteoapi/node-sdk")> {
  try {
    return await import("@larksuiteoapi/node-sdk");
  } catch (cause) {
    if (!isMissingPackage(cause)) throw cause;
    for (const dir of resolveFrom) {
      let resolved: string;
      try {
        resolved = createRequire(join(dir, "package.json")).resolve("@larksuiteoapi/node-sdk");
      } catch (inner) {
        if (isMissingPackage(inner)) continue;
        throw inner;
      }
      return await import(pathToFileURL(resolved).href);
    }
    throw cause;
  }
}

async function productionClient(
  options: FeishuWsConnectionOptions,
  callbacks: FeishuWsClientCallbacks,
): Promise<FeishuWsClient> {
  // An optional peer: only an agent that opens a WebSocket installs it (`fastagent add feishu|lark` declares it).
  const { EventDispatcher, LoggerLevel, WSClient } = await loadFeishuSdk(options.resolveFrom).catch(
    (cause: unknown) => {
      throw new Error(
        `${options.kind} websocket could not load @larksuiteoapi/node-sdk (${String(cause)}): run ` +
          `\`npm install @larksuiteoapi/node-sdk\` in the agent directory, or set channels.${options.kind}.ingress to ` +
          `"webhook" in its fastagent.json`,
        { cause },
      );
    },
  );
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

/** Open Feishu/Lark's official-SDK WebSocket connection. */
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
    // Terminal failure must release the transport here.
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
      // Abort before the first connection: `ready` still settles, and resolution here means cancellation, not
      // readiness (the LongConnection contract; serve skips ready-side effects).
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
