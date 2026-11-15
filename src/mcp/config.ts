/**
 * The MCP servers an agent opens: `mcpServers` in `fastagent.config.ts`. One list, read once, that every reader (the
 * open, `inspectMcp`, sign-in, the build's warning) is given.
 */
import { isAbsolute, resolve } from "node:path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { type DeclaredSecret, isEnvName } from "../declared-secrets.ts";
import { McpError } from "../mcp-api.ts";
import { AGENT_CONFIG_FILE } from "../paths.ts";
import { loadRawProgramConfig } from "../program-config.ts";

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
const Declaration = Schema.Union([Stdio, Http]);
const Servers = Schema.Record(Schema.String, Declaration);
/** One server as an `mcpServers` map holds it. */
export type McpServerDeclaration = typeof Declaration.Type;
export type McpServer =
  | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { name: string; type: "http"; url: string; headers: Record<string, string> };

/** A server and where it was declared: what its refusals name, and what a relative command is relative to. */
export interface McpDeclaration {
  name: string;
  server: McpServerDeclaration;
  /** The file that declared it, as a refusal names it. */
  file: string;
  /** The directory that file is in: what a command with a relative path is relative to. */
  base: string;
}

/** The `mcpServers` map `raw` holds (undefined is none), checked; every refusal names `file` and, where it can, the server. */
export function declareServers(raw: unknown, file: string): Record<string, McpServerDeclaration> {
  if (raw === undefined) return {};
  let servers: Record<string, McpServerDeclaration>;
  try {
    servers = Schema.decodeUnknownSync(Servers)(raw, { onExcessProperty: "error" });
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
  for (const [name, server] of Object.entries(servers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.includes("__") || name.length > 40) {
      throw new McpError(
        "configuration",
        `${file}: server names must be 1–40 letters, digits, hyphens or underscores, without __`,
      );
    }
    if (server.type === "http") checkMcpUrl(server.url, name, file);
    else
      for (const key of Object.keys(server.env ?? {})) {
        if (!isEnvName(key))
          throw new McpError("configuration", `${file}: invalid environment variable name for ${name}`, name);
      }
    for (const value of configStrings(server)) variables(value, name, file);
  }
  return servers;
}

/** The servers of the program in `dir` (`fastagent.config.ts`). */
export function declareMcp(programServers: unknown, dir: string, programFile = AGENT_CONFIG_FILE): McpDeclaration[] {
  return Object.entries(declareServers(programServers, programFile)).map(
    ([name, server]): McpDeclaration => ({ name, server, file: programFile, base: resolve(dir) }),
  );
}

/** Load `mcpServers` from the agent directory's `fastagent.config.ts` (or compiled `fastagent.config.js`). */
export async function loadMcp(dir: string): Promise<McpDeclaration[]> {
  const { value, file } = await loadRawProgramConfig(dir);
  return declareMcp(value?.mcpServers, dir, file);
}

function configStrings(server: McpServerDeclaration): string[] {
  return server.type === "http"
    ? Object.values(server.headers ?? {})
    : [server.command, ...(server.args ?? []), ...Object.values(server.env ?? {})];
}

function variables(value: string, server: string, file: string): string[] {
  const names: string[] = [];
  const rest = value.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
    if (!isEnvName(name))
      throw new McpError("configuration", `${file}: ${server} supports only \${NAME} substitutions`, server);
    names.push(name);
    return "";
  });
  if (rest.includes("${") || rest.includes("$("))
    throw new McpError("configuration", `${file}: unsupported substitution in ${server}`, server);
  return names;
}

/** The secrets the servers' `${NAME}` references need: each required, declared where the server is. */
export function mcpSecrets(declarations: readonly McpDeclaration[]): DeclaredSecret[] {
  return declarations.flatMap(({ name, server, file }) =>
    configStrings(server).flatMap((value) =>
      variables(value, name, file).map((secret) => ({
        name: secret,
        declaredIn: `${file} mcpServers.${name}`,
        optional: false,
      })),
    ),
  );
}

/**
 * The header and environment values with no `${VAR}` in them: the format allows a literal credential, and where the
 * file travels (a build publishes it, an image carries it) each is said. FastAgent cannot tell a secret from a
 * setting, so what a caller does with one (warn, or refuse where it would be written into a committed file) is its own.
 */
export function literalCredentials(
  declarations: readonly McpDeclaration[],
): { file: string; server: string; field: "headers" | "env"; key: string }[] {
  return declarations.flatMap(({ name, server, file }) => {
    const [field, entries]: ["headers" | "env", Readonly<Record<string, string>>] =
      server.type === "http" ? ["headers", server.headers ?? {}] : ["env", server.env ?? {}];
    return Object.entries(entries)
      .filter(([, value]) => value !== "" && !value.includes("${"))
      .map(([key]) => ({ file, server: name, field, key }));
  });
}

/**
 * The stdio servers whose command is a path relative to the file that declares it, as it is written: what a build or a
 * deploy has to be able to deliver, since a script is not found on a `PATH`. A command that starts with a `${VAR}` is
 * left to the variable, and `args` are never read as paths, since FastAgent cannot know which strings are.
 */
export function relativeCommands(declarations: readonly McpDeclaration[]): (McpDeclaration & { command: string })[] {
  return declarations.flatMap((declaration) => {
    const { server } = declaration;
    const command = server.type === "http" ? undefined : server.command;
    return command !== undefined && /[/\\]/.test(command) && !isAbsolute(command) && !command.startsWith("${")
      ? [{ ...declaration, command }]
      : [];
  });
}

/** What to write instead of a literal credential, which a header's value usually carries a scheme in front of. */
export function literalCredentialAdvice({ field, key }: { field: "headers" | "env"; key: string }): string {
  const name = key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return field === "headers"
    ? `replace the secret in it with \${${name}} (a scheme stays: \`Bearer \${${name}}\`)`
    : `write \${${name}}`;
}

export function checkMcpUrl(value: string, server?: string, file = "mcpServers"): URL {
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
      `${file}: MCP endpoints require HTTPS (HTTP is allowed only on loopback), without userinfo or fragments`,
      server,
    );
  }
  return url;
}

export function resolveMcpServers(
  declarations: readonly McpDeclaration[],
  env: Readonly<Record<string, string | undefined>>,
  only: string | undefined,
  /** Where a stdio server runs: the instance's workspace, whoever declared it. */
  cwd: string,
  /** What every process the instance starts gets (child-env.ts), under a stdio server's own `env`. */
  processEnv: Readonly<Record<string, string>>,
): McpServer[] {
  return declarations
    .filter(({ name }) => only === undefined || name === only)
    .map(({ name, server, file, base }) => {
      const expand = (value: string) =>
        value.replace(/\$\{([^}]*)\}/g, (_match, key: string) => {
          const result = env[key];
          if (!result) throw new McpError("configuration", `${file}: ${name} requires ${key}`, name);
          return result;
        });
      if (server.type === "http") {
        const headers = Object.fromEntries(
          Object.entries(server.headers ?? {}).map(([key, value]) => [key, expand(value)]),
        );
        try {
          new Headers(headers);
        } catch {
          throw new McpError("configuration", `${file}: invalid HTTP headers for ${name}`, name);
        }
        return { name, type: "http", url: checkMcpUrl(server.url, name, file).href, headers };
      }
      let command = expand(server.command);
      if (!isAbsolute(command) && /[/\\]/.test(command)) command = resolve(base, command);
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
