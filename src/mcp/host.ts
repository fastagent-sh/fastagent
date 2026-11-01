/** MCP declarations and authorization bindings before an agent is opened. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as Schema from "effect/Schema";
import { type McpAuthorization, McpError, type McpOptions, type McpServerSummary } from "../mcp-api.ts";
import { resolveSecretsDir, resolveStateRoot } from "../paths.ts";
import { agentValues } from "../value-file.ts";
import { withLockedFile } from "../locked-file.ts";
import { checkedGrant, mcpGrantFile } from "./grants.ts";
import { type McpServer, readMcpConfiguration, checkMcpUrl } from "./config.ts";

const Bindings = Schema.Record(Schema.String, Schema.String);
function decodeBindings(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Bindings))(raw);
  } catch {
    throw new McpError("storage", "Invalid MCP bindings file; refusing to overwrite it");
  }
}

export function mcpAuthorization(
  dir: string,
  env: NodeJS.ProcessEnv,
  stateRoot: string,
  options: McpOptions = {},
): McpAuthorization {
  if ((options.store === undefined) !== (options.bindings === undefined))
    throw new McpError("configuration", "MCP store and bindings must be supplied together");
  if (options.store && options.bindings) return { store: options.store, bindings: { ...options.bindings } };
  const path = join(stateRoot, "mcp-bindings.json");
  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { store: mcpGrantFile(join(resolveSecretsDir(dir, env), "mcp-auth.json")), bindings: decodeBindings(raw) };
}

export async function writeMcpBinding(stateRoot: string, server: string, id: string | undefined): Promise<void> {
  await withLockedFile(
    join(stateRoot, "mcp-bindings.json"),
    async (raw) => {
      const entries = decodeBindings(raw);
      if (id === undefined) delete entries[server];
      else entries[server] = id;
      return { result: undefined, next: `${JSON.stringify(entries)}\n` };
    },
    { create: false },
  );
}

export function mcpContext(dir: string, options: McpOptions = {}) {
  const agentDir = resolve(dir);
  const environment = { ...process.env, ...agentValues(agentDir) };
  const stateRoot = resolveStateRoot(agentDir, environment);
  return {
    agentDir,
    environment,
    stateRoot,
    auth: mcpAuthorization(agentDir, environment, stateRoot, options),
  };
}

export function httpServer(servers: readonly McpServer[], name: string): Extract<McpServer, { type: "http" }> {
  const server = servers.find((s) => s.name === name);
  if (server?.type !== "http") throw new McpError("configuration", "OAuth needs a declared HTTP MCP server", name);
  if (new Headers(server.headers).has("authorization"))
    throw new McpError(
      "configuration",
      "An MCP server cannot use a static Authorization header and an OAuth binding together",
      name,
    );
  return server;
}

export async function inspectMcp(dir: string, options: McpOptions = {}): Promise<McpServerSummary[]> {
  const { agentDir, auth } = mcpContext(dir, options);
  return Promise.all(
    Object.entries(readMcpConfiguration(agentDir).mcpServers).map(async ([name, declaration]) => {
      const server = { ...declaration, name, type: declaration.type ?? "stdio" };
      const id = Object.hasOwn(auth.bindings, server.name) ? auth.bindings[server.name] : undefined;
      const raw = id === undefined ? undefined : await auth.store.read(id);
      const grant = raw === undefined ? undefined : checkedGrant(raw);
      let authorization: McpServerSummary["authorization"] = "not_bound";
      if (declaration.type !== "http") authorization = id === undefined ? "not_required" : "binding_mismatch";
      else if (grant) {
        authorization =
          grant.serverUrl !== checkMcpUrl(declaration.url).href || new Headers(declaration.headers).has("authorization")
            ? "binding_mismatch"
            : grant.status !== "ready"
              ? "reauthorization_required"
              : grant.expiresAt !== undefined && grant.expiresAt <= Date.now() + 30_000
                ? grant.refreshToken
                  ? "refresh_needed"
                  : "reauthorization_required"
                : "ready";
      } else if (id !== undefined) authorization = "reauthorization_required";
      else if (declaration.type === "http" && new Headers(declaration.headers).has("authorization"))
        authorization = "not_required";
      return {
        name: server.name,
        transport: server.type,
        ...(declaration.type === "http" ? { url: checkMcpUrl(declaration.url).href } : {}),
        authorization,
        ...(id === undefined ? {} : { grantId: id }),
      };
    }),
  );
}
