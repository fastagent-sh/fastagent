/** MCP declarations and authorization bindings before an agent is opened. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as Schema from "effect/Schema";
import {
  type McpAuthorization,
  McpError,
  type McpInspectOptions,
  type McpOptions,
  type McpServerSummary,
} from "../mcp-api.ts";
import { resolveSecretsDir, resolveStateRoot } from "../paths.ts";
import { agentValues, prepareSecretsDirectory, unprotectedSecretsNote } from "../value-file.ts";
import { log } from "../log.ts";
import { withLockedFile } from "../locked-file.ts";
import { checkedGrant, mcpGrantFile } from "./grants.ts";
import { type McpServer, checkMcpUrl, declareMcp, mcpInstance } from "./config.ts";

const Bindings = Schema.Record(Schema.String, Schema.String);
function decodeBindings(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Bindings))(raw);
  } catch {
    throw new McpError("storage", "Invalid MCP bindings file; refusing to overwrite it");
  }
}

/** Where grants are kept when no store is given, and what makes the directory holding them safe to write to. */
interface GrantsHome {
  file: string;
  prepare?: () => Promise<string | undefined>;
}

/** The project's `.secrets/`: where the CLI keeps them. A write first makes the directory ignored by git. */
export function mcpAuthorization(
  dir: string,
  env: NodeJS.ProcessEnv,
  stateRoot: string,
  options: McpOptions = {},
): McpAuthorization {
  const secretsDir = resolveSecretsDir(dir, env);
  return authorizationIn(
    { file: join(secretsDir, "mcp-auth.json"), prepare: () => prepareSecretsDirectory(dir, secretsDir) },
    stateRoot,
    options,
  );
}

/** The instance's state directory: where an app that is given no store keeps them, beside its other state. */
export function mcpAuthorizationInState(stateRoot: string, options: McpOptions = {}): McpAuthorization {
  return authorizationIn({ file: join(stateRoot, "mcp-auth.json") }, stateRoot, options);
}

function authorizationIn(home: GrantsHome, stateRoot: string, options: McpOptions): McpAuthorization {
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
  const file = mcpGrantFile(home.file);
  const protectedWrite = async (write: () => Promise<void>) => {
    const unprotected = await home.prepare?.();
    await write();
    if (unprotected !== undefined) log.warn(`[fastagent] ${unprotectedSecretsNote(unprotected)}`);
  };
  return {
    store: {
      ...file,
      withGrant: (id, operation) =>
        file.withGrant(id, (access) =>
          operation({
            ...access,
            write: (record) => protectedWrite(() => access.write(record)),
            remove: () => protectedWrite(() => access.remove()),
          }),
        ),
    },
    bindings: decodeBindings(raw),
  };
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

export async function inspectMcp(dir: string, options: McpInspectOptions = {}): Promise<McpServerSummary[]> {
  const { agentDir, auth } = mcpContext(dir, options);
  return Promise.all(
    declareMcp(agentDir, mcpInstance(options.config)).map(async ({ name, server: declaration }) => {
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
