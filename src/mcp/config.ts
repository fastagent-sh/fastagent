/**
 * The MCP servers an instance opens (agent-artifact.md §3.3, §4.2): the program's, the `mcpServers` map of its
 * `context.json`, and what the instance adds, the `mcpServers` map of its `fastagent.json`. One list, read once, that
 * every reader (the open, `inspectMcp`, sign-in, the secrets list, the build's warning) is given.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { readProgramMcpServers } from "../content/file.ts";
import { type DeclaredSecret, isEnvName } from "../declared-secrets.ts";
import { type McpConfigInput, McpError } from "../mcp-api.ts";
import { CONTEXT_FILE } from "../paths.ts";

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
  /** The directory that file is in. None for an object, whose commands with a path must be absolute. */
  base?: string;
  origin: "program" | "instance";
}

/** The instance configuration as far as MCP reads it: its `mcpServers`, and where it is from. */
export interface McpInstance {
  values: unknown;
  label: string;
  directory?: string;
}

/** The `mcpServers` map `raw` holds (undefined is none), checked; every refusal names `file` and, where it can, the server. */
function declareServers(raw: unknown, file: string): Record<string, McpServerDeclaration> {
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

/** An instance's servers, checked: what `resolveConfig` asks of a configuration, so its refusal is the file's. */
export function checkInstanceServers(instance: McpInstance): void {
  declareServers(mapOf(instance.values), instance.label);
}

const mapOf = (values: unknown): unknown =>
  typeof values === "object" && values !== null ? (values as { mcpServers?: unknown }).mcpServers : undefined;

/**
 * The servers of the program in `dir` and of `instance`. An instance only adds: a name both declare is refused, naming
 * both, so nothing is shadowed.
 */
export function declareMcp(dir: string, instance?: McpInstance): McpDeclaration[] {
  const own = readProgramMcpServers(dir);
  const program = Object.entries(declareServers(own.values, own.path)).map(
    ([name, server]): McpDeclaration => ({ name, server, file: CONTEXT_FILE, base: resolve(dir), origin: "program" }),
  );
  if (instance === undefined) return program;
  const added = Object.entries(declareServers(mapOf(instance.values), instance.label)).map(
    ([name, server]): McpDeclaration => ({
      name,
      server,
      file: instance.label,
      ...(instance.directory === undefined ? {} : { base: instance.directory }),
      origin: "instance",
    }),
  );
  for (const { name } of added) {
    if (program.some((declared) => declared.name === name)) {
      throw new McpError(
        "configuration",
        `MCP server "${name}" is declared by the program (${CONTEXT_FILE}) and by the instance (${instance.label}): an ` +
          `instance adds to the program's servers and does not replace them — name it otherwise`,
      );
    }
  }
  return [...program, ...added];
}

/** An instance configuration given to `inspectMcp` or `signInMcp`: an object, or the absolute path of a `fastagent.json`. */
export function mcpInstance(config: McpConfigInput | undefined): McpInstance | undefined {
  if (config === undefined) return undefined;
  if (typeof config !== "string") return { values: config, label: "the config object" };
  if (!isAbsolute(config))
    throw new McpError("configuration", `config must be an absolute path, and is ${JSON.stringify(config)}`);
  let text: string;
  try {
    text = readFileSync(config, "utf8");
  } catch (error) {
    throw new McpError(
      "configuration",
      `cannot read the instance configuration ${config}: ${(error as Error).message}`,
    );
  }
  try {
    return { values: JSON.parse(text), label: config, directory: dirname(config) };
  } catch (error) {
    throw new McpError("configuration", `${config} is not JSON: ${(error as Error).message}`);
  }
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
 * file travels (a build publishes it, a deploy bakes or delivers it) each is said. FastAgent cannot tell a secret from a
 * setting, so a caller warns and never refuses.
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
      if (!isAbsolute(command) && /[/\\]/.test(command)) {
        if (base === undefined) {
          throw new McpError(
            "configuration",
            `${file}: the command "${command}" has a path and no file to be relative to: write an absolute path or a bare command`,
            name,
          );
        }
        command = resolve(base, command);
      }
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
