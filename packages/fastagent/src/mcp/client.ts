/** Instance-owned MCP clients: stdio servers, and Streamable HTTP servers with the headers their declaration names. */
import { getSystemErrorMap } from "node:util";
import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
  type CallToolResult,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
} from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { abortThenJoin, joinPromise, originalError } from "../promise-bridge.ts";
import { McpError } from "../mcp-api.ts";
import type { McpServer } from "./config.ts";
import { log } from "../log.ts";

export interface McpTool {
  name: string;
  server: string;
  definition: Tool;
  call(args: Record<string, unknown>, signal?: AbortSignal, progress?: (text: string) => void): Promise<CallToolResult>;
}
export interface McpClients {
  tools: McpTool[];
  close(): Promise<void>;
}

/**
 * The SDK starts a stdio server over `{ ...getDefaultEnvironment(), ...env }`, which adds this process's own `HOME`,
 * `PATH`, `USER` and the like under whatever is given. Naming each of them with no value, where `env` holds none,
 * leaves the server with exactly `env`: Node drops a variable whose value is undefined.
 */
function ownEnvironment(env: Record<string, string>): Record<string, string> {
  const withheld = Object.fromEntries(
    DEFAULT_INHERITED_ENV_VARS.filter((name) => !(name in env)).map((name) => [name, undefined]),
  );
  return { ...withheld, ...env } as Record<string, string>;
}

/** One HTTP request to a server: bounded in time, and never redirected (its headers are for the URL declared). */
function requestFetch(fetchImpl: typeof globalThis.fetch, timeoutMs: number): typeof globalThis.fetch {
  return (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  };
}

export async function openMcpClients(
  servers: readonly McpServer[],
  /** The transport HTTP servers are reached with; a test's stand-in. Default: the global `fetch`. */
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<McpClients> {
  const lifetime = Scope.makeUnsafe();
  const cleanupErrors: unknown[] = [];
  const tools: McpTool[] = [];
  const names = new Set<string>();
  let closing: Promise<void> | undefined;
  const run = async <A>(work: Effect.Effect<A, unknown>): Promise<A> => {
    if (closing) throw new McpError("connection", "MCP clients are closed");
    const result = await Effect.runPromiseExit(Effect.forkIn(work, lifetime).pipe(Effect.flatMap(Fiber.join)));
    if (Exit.isFailure(result)) throw originalError(result.cause);
    return result.value;
  };
  const close = () =>
    (closing ??= (async () => {
      await Effect.runPromise(Scope.close(lifetime, Exit.void));
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "MCP cleanup failed");
    })());
  let openingServer: string | undefined;
  try {
    for (const server of servers) {
      openingServer = server.name;
      const client = new Client(
        { name: "FastAgent", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 15_000, maxRetries: 0 } } },
      );
      await Effect.runPromise(
        Scope.addFinalizer(
          lifetime,
          joinPromise(() => client.close()).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                cleanupErrors.push(mcpFailure(originalError(cause), "MCP cleanup", server.name));
              }),
            ),
          ),
        ),
      );
      client.onerror = (error) => log.warn(`[mcp] ${mcpFailure(error, "Protocol error", server.name).message}`);
      let disconnected = false;
      client.onclose = () => {
        disconnected = true;
      };
      let transport: StdioClientTransport | StreamableHTTPClientTransport;
      if (server.type === "stdio") {
        transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          env: ownEnvironment(server.env),
          stderr: "pipe",
        });
        // Draining prevents a noisy child from blocking. Raw stderr can contain its supplied secrets.
        transport.stderr?.on("data", () => {});
      } else {
        transport = new StreamableHTTPClientTransport(new URL(server.url), {
          fetch: requestFetch(fetchImpl, 60_000),
          requestInit: { headers: server.headers },
        });
      }
      // Register the transport separately: SDK discovery can fail before Client takes ownership of it.
      await Effect.runPromise(
        Scope.addFinalizer(
          lifetime,
          joinPromise(() => transport.close()).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                cleanupErrors.push(mcpFailure(originalError(cause), "MCP transport cleanup", server.name));
              }),
            ),
          ),
        ),
      );
      await client.connect(transport, { timeout: 30_000 });
      if (!client.getServerCapabilities()?.tools)
        throw new McpError(
          "protocol",
          "MCP server does not offer tools; other capabilities are not supported",
          server.name,
        );
      const listed = await client.listTools(undefined, { timeout: 30_000 });
      for (const definition of listed.tools) {
        const name = `mcp__${server.name}__${definition.name}`;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || names.has(name))
          throw new McpError("configuration", `Invalid or duplicate MCP tool name ${name}`, server.name);
        names.add(name);
        tools.push({
          name,
          server: server.name,
          definition,
          async call(args, signal, progress) {
            if (disconnected)
              throw new McpError("connection", "MCP server disconnected; reopen the agent to reconnect", server.name);
            const abort = new AbortController();
            const forwarded = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
            try {
              return await run(
                abortThenJoin(
                  "MCP tool",
                  () =>
                    client.callTool(
                      { name: definition.name, arguments: args },
                      {
                        signal: forwarded,
                        timeout: 60_000,
                        ...(progress
                          ? {
                              onprogress: (value) =>
                                progress(
                                  `MCP ${server.name}: ${value.progress}${value.total === undefined ? "" : `/${value.total}`}`,
                                ),
                            }
                          : {}),
                      },
                    ),
                  () => abort.abort(),
                ),
              );
            } catch (error) {
              if (forwarded.aborted) throw forwarded.reason;
              throw mcpFailure(error, "MCP tool call", server.name);
            }
          },
        });
      }
    }
    return { tools, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([mcpFailure(error, "MCP open", openingServer), cleanup], "MCP open and cleanup failed");
    }
    throw mcpFailure(error, "MCP open", openingServer);
  }
}

const safeReasons = new Map<string, string>([
  ...getSystemErrorMap().values(),
  ["ENOTFOUND", "DNS name not found"],
  ["ERR_SSL_WRONG_VERSION_NUMBER", "TLS peer did not speak the expected protocol"],
  ["UND_ERR_CONNECT_TIMEOUT", "connection timed out"],
  ["UND_ERR_HEADERS_TIMEOUT", "response headers timed out"],
  ["UND_ERR_BODY_TIMEOUT", "response body timed out"],
  ["UND_ERR_SOCKET", "socket closed or failed"],
  ["UND_ERR_CLOSED", "HTTP client closed"],
  ["UND_ERR_DESTROYED", "HTTP client destroyed"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS certificate hostname mismatch"],
  ["CERT_HAS_EXPIRED", "TLS certificate expired"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "untrusted self-signed TLS certificate"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "untrusted TLS certificate chain"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "TLS certificate could not be verified"],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "TLS certificate issuer is not trusted"],
]);
const sdkCodes = new Set<string>(Object.values(SdkErrorCode));
const errorNames = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AbortError",
  "TimeoutError",
  "AggregateError",
  "SdkError",
]);

function safeFailureReason(error: unknown): string {
  const pending = [error];
  const seen = new Set<Error>();
  const reasons = new Set<string>();
  while (pending.length) {
    const current = pending.pop();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    const code = "code" in current && typeof current.code === "string" ? current.code : undefined;
    if (code !== undefined) {
      const reason = safeReasons.get(code);
      if (reason !== undefined) reasons.add(`${code}: ${reason}`);
      else if (sdkCodes.has(code)) reasons.add(code);
    }
    // SDK 2.4's pinned stdio probe omits structured close data; recognize only its fixed diagnostic prefix.
    if (
      current.message === "Connection closed during the version negotiation probe" ||
      (current instanceof SdkError &&
        current.code === SdkErrorCode.EraNegotiationFailed &&
        current.message.startsWith(
          "Version negotiation failed: the connection closed during the server/discover probe before the server offered pinned protocol version ",
        ))
    )
      reasons.add("CONNECTION_CLOSED: server closed during protocol discovery");
    if (
      current instanceof SdkHttpError &&
      Number.isInteger(current.status) &&
      current.status >= 100 &&
      current.status <= 599
    )
      reasons.add(`HTTP ${current.status}`);
    pending.push(current.cause);
    if (current instanceof AggregateError && Array.isArray(current.errors)) pending.push(...current.errors);
  }
  if (reasons.size) return [...reasons].join("; ");
  return error instanceof Error ? (errorNames.has(error.name) ? error.name : "Error") : "unknown error";
}

/** A failure said as an `McpError`. Messages, paths, args, stderr and raw causes can carry credentials: only allowlisted facts escape. */
function mcpFailure(error: unknown, operation: string, server?: string): McpError {
  if (error instanceof McpError)
    return error.server || !server ? error : new McpError(error.code, error.message, server);
  if (error instanceof SdkHttpError && (error.status === 401 || error.status === 403))
    return new McpError(
      "authorization_required",
      `${operation}: the MCP server refused the request (HTTP ${error.status}): check the credentials its headers carry`,
      server,
    );
  return new McpError("connection", `${operation} failed (${safeFailureReason(error)})`, server);
}
