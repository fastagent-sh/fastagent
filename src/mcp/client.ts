/** Instance-owned MCP clients. The scope also joins refreshes after a caller abandons its wait. */
import { Client, StreamableHTTPClientTransport, type Tool, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { portAbort, portJoin, portError } from "../effect-port.ts";
import { McpError, type McpAuthorization, type McpOptions } from "../mcp-api.ts";
import type { McpServer } from "./config.ts";
import { checkGrantTarget, discoverMcp, grantToken, mcpFailure } from "./auth.ts";
import { mcpFetch, openMcpNetwork } from "./network.ts";
import { checkedGrant } from "./grants.ts";
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

export async function openMcpClients(
  servers: readonly McpServer[],
  auth: McpAuthorization,
  options: Pick<McpOptions, "fetch"> = {},
): Promise<McpClients> {
  const lifetime = Scope.makeUnsafe();
  const cleanupErrors: unknown[] = [];
  const tools: McpTool[] = [];
  const names = new Set<string>();
  let closing: Promise<void> | undefined;
  const run = async <A>(work: Effect.Effect<A, unknown>): Promise<A> => {
    if (closing) throw new McpError("connection", "MCP clients are closed");
    const result = await Effect.runPromiseExit(Effect.forkIn(work, lifetime).pipe(Effect.flatMap(Fiber.join)));
    if (Exit.isFailure(result)) throw portError(result.cause);
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
          portJoin(() => client.close()).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                cleanupErrors.push(mcpFailure(portError(cause), "MCP cleanup", server.name));
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
      const grantId = Object.hasOwn(auth.bindings, server.name) ? auth.bindings[server.name] : undefined;
      let transport: StdioClientTransport | StreamableHTTPClientTransport;
      if (server.type === "stdio") {
        if (grantId !== undefined)
          throw new McpError("configuration", "A stdio MCP server cannot have an OAuth grant binding", server.name);
        transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          env: server.env,
          stderr: "pipe",
        });
        // Draining prevents a noisy child from blocking. Raw stderr can contain its supplied secrets.
        transport.stderr?.on("data", () => {});
      } else {
        const network = await openMcpNetwork(server.url, options.fetch);
        await Effect.runPromise(
          Scope.addFinalizer(
            lifetime,
            portJoin(() => network.close()).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  cleanupErrors.push(mcpFailure(portError(cause), "MCP network cleanup", server.name));
                }),
              ),
            ),
          ),
        );
        const fetchImpl = mcpFetch(server.url, network.fetch);
        const requestFetch = mcpFetch(server.url, network.fetch, 60_000);
        if (grantId !== undefined && new Headers(server.headers).has("authorization"))
          throw new McpError("configuration", "Static Authorization and OAuth cannot be combined", server.name);
        if (grantId !== undefined) {
          const held = await auth.store.read(grantId);
          if (!held)
            throw new McpError(
              "authorization_required",
              "No grant found for this MCP binding; sign in again",
              server.name,
            );
          checkGrantTarget(checkedGrant(held), server.url, await discoverMcp(server.url, fetchImpl));
        }
        const request: typeof fetch = (input, init) =>
          run(
            portJoin(async () => {
              if (grantId === undefined) return requestFetch(input, init);
              const url = input instanceof Request ? input.url : String(input);
              if (url !== server.url)
                throw new McpError(
                  "authorization_mismatch",
                  "Refusing to send an MCP token to another URL",
                  server.name,
                );
              const token = await grantToken({ store: auth.store, id: grantId, url: server.url, fetch: fetchImpl });
              init?.signal?.throwIfAborted();
              const headers = new Headers(init?.headers);
              headers.set("Authorization", `Bearer ${token.token}`);
              const response = await requestFetch(input, { ...init, headers });
              if (response.status !== 401) return response;
              await response.body?.cancel();
              const refreshed = await grantToken({
                store: auth.store,
                id: grantId,
                url: server.url,
                fetch: fetchImpl,
                rejectedGeneration: token.generation,
              });
              init?.signal?.throwIfAborted();
              headers.set("Authorization", `Bearer ${refreshed.token}`);
              const retry = await requestFetch(input, { ...init, headers });
              if (retry.status === 401) {
                await retry.body?.cancel();
                await auth.store.withGrant(grantId, async (access) => {
                  const current = access.read();
                  if (current?.generation === refreshed.generation)
                    await access.write({ ...current, status: "reauthorization_required" });
                });
                throw new McpError(
                  "authorization_required",
                  "MCP server refused the refreshed grant; sign in again",
                  server.name,
                );
              }
              return retry;
            }),
          );
        transport = new StreamableHTTPClientTransport(new URL(server.url), {
          fetch: request,
          requestInit: { headers: server.headers },
          onInsufficientScope: "throw",
        });
      }
      // Register the transport separately: SDK discovery can fail before Client takes ownership of it.
      await Effect.runPromise(
        Scope.addFinalizer(
          lifetime,
          portJoin(() => transport.close()).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                cleanupErrors.push(mcpFailure(portError(cause), "MCP transport cleanup", server.name));
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
                portAbort(
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
