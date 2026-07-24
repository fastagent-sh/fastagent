/**
 * The config subsystem: schema (defineConfig), loading (loadConfig), and value interpretation
 * (resolveModel, resolveModelSpec). One concern: everything about fastagent.config.ts.
 *
 * Red line: config describes deployment/runtime choices, never authored identity or expertise (those
 * live in persona.md + skills, with AGENTS.md as project context). In a FLAT workspace, deleting the
 * config still leaves a zero-config agent runnable with a model supplied by --model / FASTAGENT_MODEL;
 * in a STANDALONE workspace the config doubles as the structural layout marker (resolveWorkspace), so
 * deleting it un-declares the workspace.
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { FastagentTool } from "./tool.ts";
import type { Models } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, type AnyModel } from "./harness.ts";
import { moduleLoadHint } from "../../loader.ts";
import { STANDALONE_DIR, resolveOverridePath, resolveSecretsDir } from "../../workspace.ts";

// The machinery path resolution (STANDALONE_DIR, resolveStateRoot, resolveSecretsDir) lives in the
// neutral src/workspace.ts (env.ts derives the .env path from it); re-exported here — this module
// stays the one import point for config + workspace resolution.
export { STANDALONE_DIR, resolveSecretsDir, resolveStateRoot } from "../../workspace.ts";

// pi's thinking levels as a runtime value live in harness.ts (THE single source, with the
// exhaustiveness anchor against pi's union) — config validation consumes it, never redefines it.

export interface FastagentConfig {
  /** "provider/modelId". Precedence: CLI --model > FASTAGENT_MODEL > config. */
  model?: string;
  /** Reasoning effort for the model, pi's scale ("off" | "minimal" | "low" | "medium" | "high" |
   *  "xhigh" | "max"). Unset = pi's default. Authors tune thinking in the pi TUI while vibing — this
   *  is the serving-side counterpart (fidelity). Levels a model doesn't support are clamped by pi. */
  thinkingLevel?: ThinkingLevel;
  /** Extra custom tools, appended after pi defaults — never replaces them. `FastagentTool` = AgentTool
   *  plus the optional `deferred` marker (see defineTool). */
  tools?: FastagentTool[];
  http?: { port?: number };
  /** Mount the built-in `wake` tool so the agent can schedule its OWN follow-up turns (self-scheduling).
   *  Off by default — self-scheduling is an autonomy capability, opt in when you want it. Only takes
   *  effect on the serving path (`dev`/`start`, where the scheduler poller honors a wake-up). */
  selfSchedule?: boolean;
  /**
   * Serve the session control plane over HTTP (`/control/*`: state/entries/events + dispatch —
   * steer/abort/compact/set_model…) for remote consumers: a Web panel, a desktop app, `fastagent
   * attach`. Default off (it is a remote-control surface). When on, `dev`/`start` generate a
   * per-boot bearer token and write `<stateRoot>/control.json` for local discovery. The serve
   * binds all interfaces, so the routes are LAN-reachable with the token as the only protection —
   * firewall the port, or wrap it for real exposure (design §14).
   */
  sessionControl?: boolean;
  /** Deploy-time declarations for what the agent needs on the box, so real agents don't hand-write a
   *  Dockerfile / hand-set variables. */
  deploy?: {
    /** Extra secret env-var NAMES the deployed agent needs beyond the model key + channel secrets — e.g.
     *  a `GH_TOKEN` its tools use. `deploy` carries each from the LOCAL env to the host secret store and
     *  lists them in the runbook; a missing value gates `--run` (like a channel secret). */
    secrets?: string[];
    /** Extra apt packages baked into the generated image (Debian default repos: git, ripgrep, jq…). For a
     *  package needing a custom apt repo (e.g. gh) or a different base image, provide your own Dockerfile
     *  — `deploy` keeps an existing one. */
    apt?: string[];
  };
}

/** Identity function for typing and IDE completion (vite/next-style). */
export function defineConfig(config: FastagentConfig): FastagentConfig {
  return config;
}

export interface LoadedConfig {
  config: FastagentConfig;
  /** Config file path; undefined when running zero-config. */
  path?: string;
}

/** A valid bindable port. */
export function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 65535;
}

/** Validate an optional `string[]` config field where each entry must match `shape` — used for
 *  deploy.secrets (env-var names) and deploy.apt (package names); undefined is fine (field omitted). */
function validateStringList(value: unknown, key: string, shape: RegExp, desc: string, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${path}: "${key}" must be an array of strings`);
  for (const [i, v] of value.entries()) {
    if (typeof v !== "string" || !shape.test(v)) {
      throw new Error(`${path}: "${key}[${i}]" must be ${desc}`);
    }
  }
}

/** The config filenames that make a directory a fastagent workspace, in load precedence. ONE source: the
 *  loader (below) and `scaffoldWorkspace`'s already-a-workspace refusal both read this, so "is there a
 *  config?" can't diverge between them when the set changes. */
export const WORKSPACE_CONFIG_NAMES = ["fastagent.config.ts", "fastagent.config.js", "fastagent.config.mjs"] as const;

/** Load `<dir>/fastagent.config.ts|.js|.mjs`. No file = zero-config; a wrong-shape file throws. */
export async function loadConfig(dir: string): Promise<LoadedConfig> {
  const found = WORKSPACE_CONFIG_NAMES.map((name) => join(dir, name)).filter((path) => existsSync(path));
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
    // Cache-bust on file change: ESM `import()` caches by URL, so a config REWRITTEN in this process
    // (the first-run picker's write-back) would otherwise read back stale — deploy's model-travel gate
    // then contradicts the "saved model" line it just printed. mtime keeps unchanged files cached;
    // its resolution is the ceiling — a rewrite within the same timestamp tick reads stale (fine for
    // the write-back: sub-tick only on coarse-mtime filesystems, and the next process starts fresh).
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
  // Unknown keys throw: defineConfig only type-protects .ts authors; a typo in a .js/.mjs config
  // (`modle:`) must not silently degrade to zero-config.
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
    }
  }
  if (c.http !== undefined && (typeof c.http !== "object" || c.http === null)) {
    throw new Error(`${path}: "http" must be an object`);
  }
  for (const key of Object.keys(c.http ?? {})) {
    if (key !== "port") {
      throw new Error(`${path}: unknown key "http.${key}" (valid keys: port)`);
    }
  }
  if (c.http?.port !== undefined && (typeof c.http.port !== "number" || !isValidPort(c.http.port))) {
    throw new Error(`${path}: "http.port" must be an integer 0-65535`);
  }
  if (c.deploy !== undefined && (typeof c.deploy !== "object" || c.deploy === null)) {
    throw new Error(`${path}: "deploy" must be an object`);
  }
  for (const key of Object.keys(c.deploy ?? {})) {
    if (key !== "secrets" && key !== "apt") {
      throw new Error(`${path}: unknown key "deploy.${key}" (valid keys: secrets, apt)`);
    }
  }
  // secrets are UPPER_SNAKE env-var names (deploy reads their VALUES from the local env); apt entries are
  // Debian package names. Both go into a shell/env context on the host, so shape-validate them — catches a
  // typo and refuses an injection-shaped value from an otherwise-trusted config.
  validateStringList(c.deploy?.secrets, "deploy.secrets", /^[A-Z_][A-Z0-9_]*$/, "an UPPER_SNAKE env-var name", path);
  validateStringList(c.deploy?.apt, "deploy.apt", /^[a-z0-9][a-z0-9.+-]*$/, "a Debian package name", path);
  return { config: c, path };
}

/** The two workspace layouts. ONE directory shape either way — standalone just nests the whole
 *  workspace (definition + config + `.secrets/` + `.state/`) inside `<dir>/.fastagent/`. */
export type WorkspaceLayout = "flat" | "standalone";

export interface ResolvedWorkspace {
  /** The workspace ROOT — where the definition (persona.md/skills/tools/channels/schedules), the
   *  config, and the machinery dirs (`.secrets/`, `.state/`, `.cache/`) live. Absolute. */
  root: string;
  /** The WORKBENCH — what the agent works ON (its cwd; the ② context walk starts here): the parent
   *  directory for a standalone root, the root itself for flat. Absolute. */
  workbench: string;
  layout: WorkspaceLayout;
}

/**
 * Resolve a directory into its workspace: layout is STRUCTURAL, never configured. `<dir>` carrying a
 * fastagent.config.* is flat (root = workbench = dir); `<dir>/.fastagent/` carrying one is standalone
 * (root = the `.fastagent` dir, workbench = dir — the host tree stays untouched). Both at once is
 * ambiguous → throw (fail visibly, never guess). Neither = zero-config, treated as flat — "a directory
 * is an agent" stays the default. Invoked from INSIDE a standalone root (cwd = `<dir>/.fastagent`),
 * the same workspace resolves with workbench = the parent, so both invocation points behave identically.
 * The ONE owner of this rule — every command and opener resolves through here.
 */
export function resolveWorkspace(dir: string): ResolvedWorkspace {
  const base = resolve(dir);
  const hasConfig = (d: string): boolean => WORKSPACE_CONFIG_NAMES.some((name) => existsSync(join(d, name)));
  if (basename(base) === STANDALONE_DIR && hasConfig(base)) {
    return { root: base, workbench: dirname(base), layout: "standalone" };
  }
  const flat = hasConfig(base);
  const standalone = hasConfig(join(base, STANDALONE_DIR));
  if (flat && standalone) {
    throw new Error(
      `${base} has a fastagent config at BOTH the directory root and ./${STANDALONE_DIR}/ — ambiguous; keep exactly one workspace`,
    );
  }
  if (standalone) return { root: join(base, STANDALONE_DIR), workbench: base, layout: "standalone" };
  return { root: base, workbench: base, layout: "flat" };
}

/** The provider prefix of a "provider/modelId" spec. A spec without "/" returns whole — downstream
 *  lookups then miss visibly (an unknown-provider error / a login-required hint), never a mangled id
 *  (`slice(0, indexOf("/"))` silently drops the last char when "/" is absent). */
export function providerOf(spec: string): string {
  const slash = spec.indexOf("/");
  return slash > 0 ? spec.slice(0, slash) : spec;
}

/** Resolve "provider/modelId" → a pi Model from `models`, so the harness resolves auth from the same collection. */
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

/**
 * Rewrite the `model` in a config file's SOURCE TEXT to `spec`, for the first-run picker's write-back.
 * Handles the scaffold's commented placeholder (`// model: "…"`) and an existing `model:` line; returns
 * null when neither is present (zero-config or a hand-shaped config) so the caller falls back to a
 * printed hint instead of guessing where to insert. Text-level (not AST) on purpose — it only ever
 * touches a line it recognizes, never reformats the author's file.
 */
export function rewriteConfigModel(src: string, spec: string): string | null {
  const line = `  model: ${JSON.stringify(spec)},`;
  const commented = /^[ \t]*\/\/[ \t]*model:.*$/m;
  const active = /^[ \t]*model:[ \t]*["'].*$/m;
  if (commented.test(src)) return src.replace(commented, line);
  if (active.test(src)) return src.replace(active, line);
  // No model line at all — the natural state after "picked once, then hand-deleted the line to reset".
  // Re-INSERT at the top of the default-export object while the config still has the scaffold's block
  // shape; anything else (a wrapper call, a one-liner, a computed export) is hand-shaped — leave it
  // untouched (the caller prints the set-it-yourself hint).
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
 * `start`'s sessions-dir override: `--sessions-dir` flag > `FASTAGENT_SESSIONS_DIR` env > undefined
 * (the opener then falls back to {@link defaultSessionsDir} under the {@link resolveStateRoot} root).
 * Resolved to absolute so the store and the startup report agree regardless of cwd.
 */
export function resolveSessionsDirOverride(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveOverridePath(flag ?? env.FASTAGENT_SESSIONS_DIR);
}

/**
 * The auth-file override: `--auth-path` flag > `FASTAGENT_AUTH_PATH` env > undefined (the opener then
 * falls back to {@link defaultAuthPath} under the {@link resolveStateRoot} root). Resolved to absolute
 * so the store and the startup report agree regardless of cwd. No implicit project↔global fallback (isolation
 * + fail-visibly; see auth.ts); to share one account across projects, point this at the global
 * `~/.fastagent/auth.json` — sharing ONE file is safe under the store's cross-process refresh lock.
 */
export function resolveAuthPathOverride(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveOverridePath(flag ?? env.FASTAGENT_AUTH_PATH);
}

/** The default credentials file under a resolved secrets dir ({@link resolveSecretsDir}). */
export function defaultAuthPath(secretsDir: string): string {
  return join(secretsDir, "auth.json");
}

/** The effective auth file for a workspace: override if present, else `<secrets dir>/auth.json`. */
export function resolveAuthPath(dir: string, flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return resolveAuthPathOverride(flag, env) ?? defaultAuthPath(resolveSecretsDir(dir, env));
}

/** The default sessions dir under a resolved state root ({@link resolveStateRoot}). */
export function defaultSessionsDir(stateRoot: string): string {
  return join(stateRoot, "sessions");
}
