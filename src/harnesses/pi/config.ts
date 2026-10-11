/**
 * The config subsystem: schema (defineConfig), loading (loadConfig), and value interpretation (resolveModel,
 * resolveModelSpec).
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { FastagentTool } from "./tool.ts";
import type { Models } from "@earendil-works/pi-ai";
import type { AnyModel } from "./models.ts";
import { THINKING_LEVELS } from "./session-settings.ts";
import { readSecretDeclaration } from "../../declared-secrets.ts";
import { assertCorsOrigins } from "../../channels/serve.ts";
import type { HttpSurface } from "../../service.ts";
import { moduleLoadHint } from "../../loader.ts";
import { AGENT_CONFIG_FILE, CONTEXT_FILE } from "../../paths.ts";

// pi's thinking levels as a runtime value live in session-settings.ts (THE single source, with the exhaustiveness
// anchor against pi's union).

export interface FastagentConfig {
  /** "provider/modelId". */
  model?: string;
  /** Reasoning effort for the model, pi's scale ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"). */
  thinkingLevel?: ThinkingLevel;
  /** Extra custom tools, appended after the pi coding tools — never replaces them. */
  tools?: FastagentTool[];
  /** What the serve publishes on its port, and to which browsers (each key is documented on {@link HttpSurface}). */
  http?: HttpSurface & {
    /** Default port for `dev` / `start` (`DEFAULT_HTTP_PORT` when unset). */
    port?: number;
  };
  /**
   * Serve the session control plane over HTTP (`/control/*`: state/entries/events + dispatch — steer/abort/compact +
   * session properties and lifecycle) for remote consumers.
   */
  sessionControl?: boolean;
  /** How the agent is deployed, where a host needs to be told. */
  deploy?: {
    /** `deploy agentcore` only. */
    agentcore?: {
      /**
       * How long an idle AgentCore session keeps its microVM, 60–1209600 seconds (default 180). Memory bills for the
       * whole idle tail, and a session past it cold-starts — the workload picks the trade: a chat agent talked to in
       * bursts wants a longer tail, a schedule-only agent a shorter one.
       */
      idleTimeoutSeconds?: number;
    };
  };
}

/** Identity function for typing and IDE completion (vite/next-style). */
export function defineConfig(config: FastagentConfig): FastagentConfig {
  return config;
}

export interface LoadedConfig {
  config: FastagentConfig;
  /** Config file path; undefined when the loader was pointed at a directory holding none. */
  path?: string;
}

export function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 65535;
}

/** Refuse a key `level` does not have, naming the keys it does (the ONE list both the check and the message read). */
function refuseUnknownKeys(level: object, valid: readonly string[], prefix: string, path: string): void {
  for (const key of Object.keys(level)) {
    if (!valid.includes(key)) {
      throw new Error(`${path}: unknown key "${prefix}${key}" (valid keys: ${valid.join(", ")})`);
    }
  }
}

/** Load and validate `<dir>/fastagent.config.ts`. */
export async function loadConfig(dir: string): Promise<LoadedConfig> {
  const path = join(dir, AGENT_CONFIG_FILE);
  if (!existsSync(path)) return { config: {} };
  return { config: await loadConfigFile(path), path };
}

async function loadConfigFile(path: string): Promise<FastagentConfig> {
  let mod: { default?: unknown };
  try {
    // Cache-bust on file change: ESM `import()` caches by URL, so a config REWRITTEN in this process (the first-run
    // picker's write-back) would otherwise read back stale. An INTEGER stamp (mtimeNs), because `mtimeMs` carries a
    // fraction and a loader that decides how to transform a module by looking at the last dot in the URL reads
    // `…config.ts?v=1789701227227.251` as extension `251` and parses the file as JavaScript — which the scaffold's
    // `import type` + `satisfies` (what makes an editor complete these keys) does not survive.
    const url = pathToFileURL(path);
    url.searchParams.set("v", String(statSync(path, { bigint: true }).mtimeNs));
    mod = (await import(url.href)) as { default?: unknown };
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}${moduleLoadHint(error as NodeJS.ErrnoException)}`);
  }
  const config = mod.default;
  if (!config || typeof config !== "object") {
    throw new Error(`${path}: must default-export defineConfig({...})`);
  }
  const c = config as FastagentConfig;
  // Unknown keys throw. This is NOT redundant with `defineConfig`'s types: Node strips types without checking them,
  // so `modle:` reaches here whatever the editor said, and silently degrading to defaults is the failure it would
  // otherwise cause.
  for (const key of ["content", "contexts"]) {
    if (key in c) throw new Error(`${path}: "${key}" is not a config key — content is declared in ${CONTEXT_FILE}`);
  }
  refuseUnknownKeys(c, ["model", "thinkingLevel", "tools", "http", "deploy", "sessionControl"], "", path);
  if (c.model !== undefined && typeof c.model !== "string") {
    throw new Error(`${path}: "model" must be a "provider/modelId" string`);
  }
  if (c.sessionControl !== undefined && typeof c.sessionControl !== "boolean") {
    throw new Error(`${path}: "sessionControl" must be a boolean`);
  }
  if (c.thinkingLevel !== undefined && !(THINKING_LEVELS as ReadonlySet<string>).has(c.thinkingLevel as string)) {
    throw new Error(`${path}: "thinkingLevel" must be one of ${[...THINKING_LEVELS].join(", ")}`);
  }
  if (c.tools !== undefined && !Array.isArray(c.tools)) {
    throw new Error(`${path}: "tools" must be an array of AgentTool`);
  }
  if (c.tools !== undefined) {
    for (const [i, tool] of c.tools.entries()) {
      if (!tool || typeof tool !== "object") {
        throw new Error(`${path}: "tools[${i}]" must be an AgentTool object`);
      }
      const candidate = tool as { name?: unknown; execute?: unknown };
      if (typeof candidate.name !== "string" || typeof candidate.execute !== "function") {
        throw new Error(`${path}: "tools[${i}]" must have string "name" and function "execute"`);
      }
      // The declaration's SHAPE, checked with the same read the code-input loaders use. Here rather
      // than at tool resolution because this is the author's own config file: a wrong shape in it is
      // a config error like any other (it stops the command with one line naming the entry), while a
      // wrong shape below `tools/` is that module's load failure, reported with its file.
      const declaration = readSecretDeclaration(candidate, `${path}: "tools[${i}]"`);
      if (declaration.error !== undefined) throw new Error(declaration.error);
    }
  }
  if (c.http !== undefined && (typeof c.http !== "object" || c.http === null)) {
    throw new Error(`${path}: "http" must be an object`);
  }
  refuseUnknownKeys(c.http ?? {}, ["port", "cors", "invoke"], "http.", path);
  if (c.http?.invoke !== undefined && typeof c.http.invoke !== "boolean") {
    throw new Error(`${path}: "http.invoke" must be a boolean`);
  }
  if (c.http?.cors !== undefined) assertCorsOrigins(c.http.cors, `${path}: "http.cors"`);
  if (c.http?.port !== undefined && (typeof c.http.port !== "number" || !isValidPort(c.http.port))) {
    throw new Error(`${path}: "http.port" must be an integer 0-65535`);
  }
  if (c.deploy !== undefined && (typeof c.deploy !== "object" || c.deploy === null)) {
    throw new Error(`${path}: "deploy" must be an object`);
  }
  if (c.deploy && "apt" in c.deploy) {
    throw new Error(
      `${path}: "deploy.apt" is not a config key — system packages are declared in mise.toml [bootstrap.packages] ` +
        `(\`fastagent env bootstrap packages use apt:<name>\`), for every platform at once`,
    );
  }
  refuseUnknownKeys(c.deploy ?? {}, ["agentcore"], "deploy.", path);
  if (c.deploy?.agentcore !== undefined && (typeof c.deploy.agentcore !== "object" || c.deploy.agentcore === null)) {
    throw new Error(`${path}: "deploy.agentcore" must be an object`);
  }
  refuseUnknownKeys(c.deploy?.agentcore ?? {}, ["idleTimeoutSeconds"], "deploy.agentcore.", path);
  // AWS's own bounds for idleRuntimeSessionTimeout: a value outside them is rejected by CloudFormation minutes into
  // `deploy agentcore --run`, after the image build.
  const idle = c.deploy?.agentcore?.idleTimeoutSeconds;
  if (idle !== undefined && (!Number.isInteger(idle) || idle < 60 || idle > 1209600)) {
    throw new Error(`${path}: "deploy.agentcore.idleTimeoutSeconds" must be an integer 60-1209600 (seconds)`);
  }
  return c;
}

/** The provider prefix of a "provider/modelId" spec. */
export function providerOf(spec: string): string {
  const slash = spec.indexOf("/");
  return slash > 0 ? spec.slice(0, slash) : spec;
}

/** Resolve "provider/modelId" → a pi Model from `models`, so auth resolves from the same collection. */
export function resolveModel(models: Models, spec: string): AnyModel {
  const slash = spec.indexOf("/");
  if (slash < 1 || slash === spec.length - 1) {
    throw new Error(`model must be "provider/modelId" (e.g. "openai-codex/gpt-5.5"), got "${spec}"`);
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const model = models.getModel(provider, modelId) as AnyModel | undefined;
  if (!model) {
    throw new Error(
      `unknown model "${spec}" (provider "${provider}" / id "${modelId}" not in registry); run \`fastagent models\` to list ` +
        "available specs, or `fastagent models --refresh` in the agent to fetch models newer than the installed pi",
    );
  }
  return model;
}

/** All registered "provider/modelId" specs in `models`, sorted — the list behind `fastagent models`. */
export function listModels(models: Models): string[] {
  const specs: string[] = [];
  for (const provider of models.getProviders()) {
    for (const model of provider.getModels()) specs.push(`${provider.id}/${model.id}`);
  }
  return specs.sort();
}

/** Rewrite the `model` in a config file's SOURCE TEXT to `spec`, for the first-run picker's write-back. */
export function rewriteConfigModel(src: string, spec: string): string | null {
  const line = `  model: ${JSON.stringify(spec)},`;
  const commented = /^[ \t]*\/\/[ \t]*model:.*$/m;
  const active = /^[ \t]*model:[ \t]*["'].*$/m;
  if (commented.test(src)) return src.replace(commented, line);
  if (active.test(src)) return src.replace(active, line);
  // No model line at all — the natural state after "picked once, then hand-deleted the line to reset".
  const opener = /^export default[ \t]*\{[ \t]*$/m;
  if (opener.test(src)) return src.replace(opener, (open) => `${open}\n${line}`);
  return null;
}

/**
 * Model selection precedence: CLI flag > FASTAGENT_MODEL env > config default. An EMPTY `FASTAGENT_MODEL` is
 * "unset", not "no model": `export FASTAGENT_MODEL=` in a shell or CI job, and an `environment:`/`env` entry that
 * interpolates a missing variable, both arrive as `""` — and a set-but-empty value that shadowed `config.model`
 * would refuse to start an agent whose config names a model.
 */
export function resolveModelSpec(
  flag: string | undefined,
  config: FastagentConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return flag ?? (env.FASTAGENT_MODEL || config.model);
}

/**
 * The refusal of a process that runs the agent here (the CLI's dev/start/invoke, and chat) when no
 * default model resolves. The agent itself opens without one; such a process would fail every new conversation, so it
 * stops at startup instead.
 */
export function missingDefaultModel(): Error {
  return new Error(
    `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
  );
}
