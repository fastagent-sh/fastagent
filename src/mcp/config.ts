/** The sole MCP declaration: .mcp.json in the agent directory, resolved against this instance's environment. */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { type DeclaredSecret, isEnvName } from "../declared-secrets.ts";
import { McpError } from "../mcp-api.ts";

export const MCP_FILE = ".mcp.json";
const Strings = Schema.Record(Schema.String, Schema.String);
const Stdio = Schema.Struct({
  type: Schema.optional(Schema.Literal("stdio")),
  command: Schema.NonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Strings),
});
const Http = Schema.Struct({
  type: Schema.Literal("http"),
  url: Schema.String,
  headers: Schema.optional(Strings),
});
const Configuration = Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Union([Stdio, Http])) });
export type McpConfiguration = typeof Configuration.Type;
export type McpServer =
  | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { name: string; type: "http"; url: string; headers: Record<string, string> };

export function readMcpConfiguration(dir: string): McpConfiguration {
  const file = join(dir, MCP_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
    throw error;
  }
  let config: McpConfiguration;
  try {
    config = Schema.decodeUnknownSync(Schema.fromJsonString(Configuration))(text, { onExcessProperty: "error" });
  } catch (error) {
    const paths =
      error instanceof Error && SchemaIssue.isIssue(error.cause)
        ? SchemaIssue.makeFormatterStandardSchemaV1()(error.cause).issues.map((issue) => issue.path)
        : [];
    throw new McpError(
      "configuration",
      `${file}: invalid MCP configuration at ${JSON.stringify(paths)}; expected stdio command/args/env or http url/headers; unknown fields are refused`,
    );
  }
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.includes("__") || name.length > 40) {
      throw new McpError(
        "configuration",
        `${file}: server names must be 1–40 letters, digits, hyphens or underscores, without __`,
      );
    }
    if (server.type === "http") checkMcpUrl(server.url, name);
    else
      for (const key of Object.keys(server.env ?? {})) {
        if (!isEnvName(key))
          throw new McpError("configuration", `${file}: invalid environment variable name for ${name}`, name);
      }
    for (const value of configStrings(server)) variables(value, name);
  }
  return config;
}

function configStrings(server: McpConfiguration["mcpServers"][string]): string[] {
  return server.type === "http"
    ? Object.values(server.headers ?? {})
    : [server.command, ...(server.args ?? []), ...Object.values(server.env ?? {})];
}

function variables(value: string, server: string): string[] {
  const names: string[] = [];
  const rest = value.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
    if (!isEnvName(name))
      throw new McpError("configuration", `${MCP_FILE}: ${server} supports only \${NAME} substitutions`, server);
    names.push(name);
    return "";
  });
  if (rest.includes("${") || rest.includes("$("))
    throw new McpError("configuration", `${MCP_FILE}: unsupported substitution in ${server}`, server);
  return names;
}

export function mcpSecrets(dir: string): DeclaredSecret[] {
  return Object.entries(readMcpConfiguration(dir).mcpServers).flatMap(([server, config]) =>
    configStrings(config).flatMap((value) =>
      variables(value, server).map((name) => ({
        name,
        declaredIn: `${MCP_FILE} mcpServers.${server}`,
        optional: false,
      })),
    ),
  );
}

export function checkMcpUrl(value: string, server?: string): URL {
  const url = URL.parse(value);
  if (
    !url ||
    value.includes("${") ||
    value.includes("$(") ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new McpError(
      "configuration",
      `${MCP_FILE}: MCP endpoints require HTTPS (HTTP is allowed only on loopback), without userinfo or fragments`,
      server,
    );
  }
  return url;
}

export function resolveMcpServers(
  dir: string,
  env: Readonly<Record<string, string | undefined>>,
  only: string | undefined,
  /** Where a stdio server runs: the instance's directory when the definition's own is read-only. */
  cwd: string,
  /** What every process the instance starts gets (child-env.ts), under a stdio server's own `env`. */
  processEnv: Readonly<Record<string, string>>,
): McpServer[] {
  const config = readMcpConfiguration(dir);
  return Object.entries(config.mcpServers)
    .filter(([name]) => only === undefined || name === only)
    .map(([name, server]) => {
      const expand = (value: string) =>
        value.replace(/\$\{([^}]*)\}/g, (_match, key: string) => {
          const result = env[key];
          if (!result) throw new McpError("configuration", `${MCP_FILE}: ${name} requires ${key}`, name);
          return result;
        });
      if (server.type === "http") {
        const headers = Object.fromEntries(
          Object.entries(server.headers ?? {}).map(([key, value]) => [key, expand(value)]),
        );
        try {
          new Headers(headers);
        } catch {
          throw new McpError("configuration", `${MCP_FILE}: invalid HTTP headers for ${name}`, name);
        }
        return { name, type: "http", url: checkMcpUrl(server.url, name).href, headers };
      }
      let command = expand(server.command);
      if (!isAbsolute(command) && /[/\\]/.test(command)) command = resolve(dir, command);
      return {
        name,
        type: "stdio",
        command,
        args: (server.args ?? []).map(expand),
        cwd: resolve(cwd),
        env: {
          ...processEnv,
          ...Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, expand(value)])),
        },
      };
    });
}
