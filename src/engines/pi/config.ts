/**
 * The config subsystem: schema (defineConfig), loading (loadConfig), and value interpretation (resolveModel,
 * resolveModelSpec).
 */
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { FastagentTool } from "./tool.ts";
import type { Models } from "@earendil-works/pi-ai";
import type { AnyModel } from "./models.ts";
import { THINKING_LEVELS } from "./session-settings.ts";
import { readSecretDeclaration } from "../../declared-secrets.ts";
import { isBindAddress } from "../../bind.ts";
import { moduleLoadHint } from "../../loader.ts";
import { AGENT_CONFIG_NAMES, resolveOverridePath, resolveSecretsDir } from "../../paths.ts";

// pi's thinking levels as a runtime value live in session-settings.ts (THE single source, with the exhaustiveness
// anchor against pi's union).

export interface FastagentConfig {
  /** "provider/modelId". */
  model?: string;
  /** Reasoning effort for the model, pi's scale ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"). */
  thinkingLevel?: ThinkingLevel;
  /** Extra custom tools, appended after the pi coding tools — never replaces them. */
  tools?: FastagentTool[];
  /**
   * `host` is the bind address: unset (or `0.0.0.0`) binds all interfaces — what containers need; `127.0.0.1` keeps
   * the serve (including `/control/*`) off the LAN.
   */
  http?: { port?: number; host?: string };
  /** Mount the built-in `wake` tool so the agent can schedule its OWN follow-up turns (self-scheduling). */
  selfSchedule?: boolean;
  /**
   * Serve the session control plane over HTTP (`/control/*`: state/entries/events + dispatch — steer/abort/compact +
   * session properties and lifecycle) for remote consumers.
   */
  sessionControl?: boolean;
  /**
   * Deploy-time declarations for what the agent needs on the box, so real agents don't hand-write a Dockerfile /
   * hand-set variables.
   */
  deploy?: {
    /**
     * Extra secret env-var NAMES the deployed agent needs beyond the model key + channel secrets — e.g. a `GH_TOKEN`
     * its tools use.
     */
    secrets?: string[];
    /** Extra apt packages baked into the generated image (Debian default repos: git, ripgrep, jq…). */
    apt?: string[];
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

/** Validate an optional `string[]` config field where each entry must match `shape`. */
function validateStringList(value: unknown, key: string, shape: RegExp, desc: string, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${path}: "${key}" must be an array of strings`);
  for (const [i, v] of value.entries()) {
    if (typeof v !== "string" || !shape.test(v)) {
      throw new Error(`${path}: "${key}[${i}]" must be ${desc}`);
    }
  }
}

/** Load `<dir>/fastagent.config.ts|.js|.mjs`. */
export async function loadConfig(dir: string): Promise<LoadedConfig> {
  const found = AGENT_CONFIG_NAMES.map((name) => join(dir, name)).filter((path) => existsSync(path));
  if (found.length === 0) return { config: {} };
  if (found.length > 1) {
    throw new Error(
      `${dir}: multiple fastagent config files found; keep exactly one (${found.map((p) => basename(p)).join(", ")})`,
    );
  }

  // biome-ignore lint/style/noNonNullAssertion: length checked above — exactly one element here
  const path = found[0]!;
  let mod: { default?: unknown };
  try {
    // Cache-bust on file change: ESM `import()` caches by URL, so a config REWRITTEN in this process (the first-run
    // picker's write-back) would otherwise read back stale.
    const url = pathToFileURL(path);
    url.searchParams.set("v", String(statSync(path).mtimeMs));
    mod = (await import(url.href)) as { default?: unknown };
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}${moduleLoadHint(error as NodeJS.ErrnoException)}`);
  }
  const config = mod.default;
  if (!config || typeof config !== "object") {
    throw new Error(`${path}: must default-export defineConfig({...})`);
  }
  const c = config as FastagentConfig;
  // Unknown keys throw: defineConfig only type-protects .ts authors; a typo in a .js/.mjs config (`modle:`) must not
  // silently degrade to defaults.
  for (const key of Object.keys(c)) {
    if (
      key !== "model" &&
      key !== "thinkingLevel" &&
      key !== "tools" &&
      key !== "http" &&
      key !== "deploy" &&
      key !== "selfSchedule" &&
      key !== "sessionControl"
    ) {
      throw new Error(
        `${path}: unknown key "${key}" (valid keys: model, thinkingLevel, tools, http, deploy, selfSchedule, sessionControl)`,
      );
    }
  }
  if (c.model !== undefined && typeof c.model !== "string") {
    throw new Error(`${path}: "model" must be a "provider/modelId" string`);
  }
  if (c.sessionControl !== undefined && typeof c.sessionControl !== "boolean") {
    throw new Error(`${path}: "sessionControl" must be a boolean`);
  }
  if (c.thinkingLevel !== undefined && !(THINKING_LEVELS as ReadonlySet<string>).has(c.thinkingLevel as string)) {
    throw new Error(`${path}: "thinkingLevel" must be one of ${[...THINKING_LEVELS].join(", ")}`);
  }
  if (c.selfSchedule !== undefined && typeof c.selfSchedule !== "boolean") {
    throw new Error(`${path}: "selfSchedule" must be a boolean`);
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
      // wrong shape in `tools/x.ts` is that one file's load failure and the agent serves without it.
      const declaration = readSecretDeclaration(candidate, `${path}: "tools[${i}]"`);
      if (declaration.error !== undefined) throw new Error(declaration.error);
    }
  }
  if (c.http !== undefined && (typeof c.http !== "object" || c.http === null)) {
    throw new Error(`${path}: "http" must be an object`);
  }
  for (const key of Object.keys(c.http ?? {})) {
    if (key !== "port" && key !== "host") {
      throw new Error(`${path}: unknown key "http.${key}" (valid keys: port, host)`);
    }
  }
  if (c.http?.port !== undefined && (typeof c.http.port !== "number" || !isValidPort(c.http.port))) {
    throw new Error(`${path}: "http.port" must be an integer 0-65535`);
  }
  // Validated as strictly as http.port: an unbindable string ("banana") must fail HERE, not surface later as a
  // topology diagnostic about "the interface you bound".
  if (c.http?.host !== undefined && (typeof c.http.host !== "string" || !isBindAddress(c.http.host))) {
    throw new Error(`${path}: "http.host" must be an IP address or "localhost" (e.g. "127.0.0.1", "0.0.0.0")`);
  }
  if (c.deploy !== undefined && (typeof c.deploy !== "object" || c.deploy === null)) {
    throw new Error(`${path}: "deploy" must be an object`);
  }
  for (const key of Object.keys(c.deploy ?? {})) {
    if (key !== "secrets" && key !== "apt" && key !== "agentcore") {
      throw new Error(`${path}: unknown key "deploy.${key}" (valid keys: secrets, apt, agentcore)`);
    }
  }
  if (c.deploy?.agentcore !== undefined && (typeof c.deploy.agentcore !== "object" || c.deploy.agentcore === null)) {
    throw new Error(`${path}: "deploy.agentcore" must be an object`);
  }
  for (const key of Object.keys(c.deploy?.agentcore ?? {})) {
    if (key !== "idleTimeoutSeconds") {
      throw new Error(`${path}: unknown key "deploy.agentcore.${key}" (valid keys: idleTimeoutSeconds)`);
    }
  }
  // AWS's own bounds for idleRuntimeSessionTimeout: a value outside them is rejected by CloudFormation minutes into
  // `deploy agentcore --run`, after the image build.
  const idle = c.deploy?.agentcore?.idleTimeoutSeconds;
  if (idle !== undefined && (!Number.isInteger(idle) || idle < 60 || idle > 1209600)) {
    throw new Error(`${path}: "deploy.agentcore.idleTimeoutSeconds" must be an integer 60-1209600 (seconds)`);
  }
  // secrets are UPPER_SNAKE env-var names (deploy reads their VALUES from the local env); apt entries are Debian
  // package names.
  validateStringList(c.deploy?.secrets, "deploy.secrets", /^[A-Z_][A-Z0-9_]*$/, "an UPPER_SNAKE env-var name", path);
  validateStringList(c.deploy?.apt, "deploy.apt", /^[a-z0-9][a-z0-9.+-]*$/, "a Debian package name", path);
  return { config: c, path };
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
      `unknown model "${spec}" (provider "${provider}" / id "${modelId}" not in registry); run \`fastagent models\` to list available specs`,
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

/** Model selection precedence: CLI flag > FASTAGENT_MODEL env > config default. */
export function resolveModelSpec(
  flag: string | undefined,
  config: FastagentConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return flag ?? env.FASTAGENT_MODEL ?? config.model;
}

/**
 * `start`'s sessions-dir override: `--sessions-dir` flag > `FASTAGENT_SESSIONS_DIR` env > undefined (the opener then
 * falls back to {@link defaultSessionsDir} under the {@link resolveStateRoot} root).
 */
export function resolveSessionsDirOverride(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveOverridePath(flag ?? env.FASTAGENT_SESSIONS_DIR);
}

/**
 * The auth-file override: `--auth-path` flag > `FASTAGENT_AUTH_PATH` env > undefined (the opener then falls back to
 * {@link defaultAuthPath} under the {@link resolveSecretsDir} dir).
 */
function resolveAuthPathOverride(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveOverridePath(flag ?? env.FASTAGENT_AUTH_PATH);
}

/** The default credentials file under a resolved secrets dir ({@link resolveSecretsDir}). */
export function defaultAuthPath(secretsDir: string): string {
  return join(secretsDir, "auth.json");
}

/** The effective auth file for an agent: override if present, else `<secrets dir>/auth.json`. */
export function resolveAuthPath(dir: string, flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return resolveAuthPathOverride(flag, env) ?? defaultAuthPath(resolveSecretsDir(dir, env));
}

/** The default sessions dir under a resolved state root ({@link resolveStateRoot}). */
export function defaultSessionsDir(stateRoot: string): string {
  return join(stateRoot, "sessions");
}
