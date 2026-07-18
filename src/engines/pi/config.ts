/**
 * The config subsystem: schema (defineConfig), loading (loadConfig), and value interpretation
 * (resolveModel, resolveModelSpec). One concern: everything about fastagent.config.ts.
 *
 * Red line: config describes deployment/runtime choices, never authored identity or expertise (those
 * live in persona.md + skills, with AGENTS.md as project context). Deleting the config still leaves a
 * zero-config agent runnable with a model supplied by --model / FASTAGENT_MODEL.
 */
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { FastagentTool } from "./tool.ts";
import type { Models } from "@earendil-works/pi-ai";
import type { AnyModel } from "./harness.ts";
import { moduleLoadHint } from "../../loader.ts";

/** pi's thinking levels (types.d.ts `ThinkingLevel`), as a runtime list for config validation — pi
 *  exports only the type. A level the selected model does not support is clamped by pi per model. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

export interface FastagentConfig {
  /** "provider/modelId". Precedence: CLI --model > FASTAGENT_MODEL > config. */
  model?: string;
  /** Reasoning effort for the model, pi's scale ("off" | "minimal" | "low" | "medium" | "high" |
   *  "xhigh" | "max"). Unset = pi's default. Authors tune thinking in the pi TUI while vibing — this
   *  is the serving-side counterpart (fidelity). Levels a model doesn't support are clamped by pi. */
  thinkingLevel?: ThinkingLevel;
  /**
   * The agent-definition subdirectory (persona.md, skills/, tools/, channels/), relative to the config
   * file's directory. Default: the config directory itself (flat — today's behaviour). Point it at a
   * sibling like `"./agent"` to serve an existing repo as a coding agent: the config dir stays the run
   * root (cwd, whose AGENTS.md the agent reads as ② context), while the agent's own surface lives in the
   * subdir and does not collide with the host's `tools/`/`src/` (core.md scenario grid).
   */
  agentDir?: string;
  /** Extra custom tools, appended after pi defaults — never replaces them. `FastagentTool` = AgentTool
   *  plus the optional `deferred` marker (see defineTool). */
  tools?: FastagentTool[];
  http?: { port?: number };
  /** Mount the built-in `wake` tool so the agent can schedule its OWN follow-up turns (self-scheduling).
   *  Off by default — self-scheduling is an autonomy capability, opt in when you want it. Only takes
   *  effect on the serving path (`dev`/`start`, where the scheduler poller honors a wake-up). */
  selfSchedule?: boolean;
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
    // then contradicts the "saved model" line it just printed. mtime keeps unchanged files cached.
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
      key !== "agentDir" &&
      key !== "tools" &&
      key !== "http" &&
      key !== "deploy" &&
      key !== "selfSchedule"
    ) {
      throw new Error(
        `${path}: unknown key "${key}" (valid keys: model, thinkingLevel, agentDir, tools, http, deploy, selfSchedule)`,
      );
    }
  }
  if (c.model !== undefined && typeof c.model !== "string") {
    throw new Error(`${path}: "model" must be a "provider/modelId" string`);
  }
  if (c.thinkingLevel !== undefined && !(THINKING_LEVELS as readonly string[]).includes(c.thinkingLevel as string)) {
    throw new Error(`${path}: "thinkingLevel" must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  if (c.agentDir !== undefined && typeof c.agentDir !== "string") {
    throw new Error(`${path}: "agentDir" must be a string (a subdirectory relative to the config file)`);
  }
  if (typeof c.agentDir === "string") {
    // Enforce the documented "subdirectory of the config dir" contract: an escaping agentDir (e.g.
    // "../shared") would still resolve for tool/channel/persona discovery, but `dev`'s chokidar only
    // watches the config dir subtree — edits outside it would silently never trigger a restart. Reject
    // it here (fail visibly) rather than let hot-reload break without a signal.
    const rel = relative(dir, resolve(dir, c.agentDir));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(
        `${path}: "agentDir" ("${c.agentDir}") must be a subdirectory of the config directory, not escape it`,
      );
    }
    // An explicitly declared agentDir that doesn't exist is a typo until proven otherwise ("./agnet"):
    // without this check every opener would assemble an EMPTY agent (no persona, no skills, no tools)
    // with zero errors — the worst silent failure this config can produce. Deliberately NOT auto-created:
    // config load is read-only (no implicit operations), and a mkdir would turn the typo into a served
    // empty agent plus a junk directory.
    // lstat, not stat: a symlink would pass the literal containment check above while its TARGET lives
    // outside the config dir — exactly what that check exists to prevent (dev's watch would silently
    // never see edits). Same rule as init's parent preflight: reject, don't follow.
    const agentDirAbs = resolve(dir, c.agentDir);
    const st = lstatSync(agentDirAbs, { throwIfNoEntry: false });
    if (!st) {
      throw new Error(`${path}: "agentDir" ("${c.agentDir}") does not exist — create it, or fix the path`);
    }
    if (st.isSymbolicLink()) {
      // Separate message: to its user a symlink LOOKS like a working directory — name the reason and the fix.
      throw new Error(
        `${path}: "agentDir" ("${c.agentDir}") is a symlink — not allowed (its target can live outside the ` +
          `config directory, where dev's watch would never see edits); use a real directory, or point agentDir at the target's real path`,
      );
    }
    if (!st.isDirectory()) {
      throw new Error(`${path}: "agentDir" ("${c.agentDir}") is not a directory`);
    }
    // The leaf lstat can't see a symlinked INTERMEDIATE segment (agentDir "./a/b" with `a` → outside):
    // realpath equality covers every segment under the config dir in one comparison. dir itself is
    // realpath'd on both sides, so a symlinked config-dir path (macOS /tmp) stays legal.
    if (realpathSync(agentDirAbs) !== resolve(realpathSync(dir), relative(dir, agentDirAbs))) {
      throw new Error(
        `${path}: "agentDir" ("${c.agentDir}") resolves through a symlink — not allowed (the target can ` +
          `live outside the config directory, where dev's watch would never see edits); use the real path`,
      );
    }
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

/**
 * The agent-definition dir from config: `config.agentDir` resolved against `dir`, or `dir` itself when
 * unset (flat). The ONE place this is computed — every opener (`dev`/`start`/`info`/`tool`/`deploy`/`chat`)
 * calls it, so the "relative to the config dir, default `.`" rule can never diverge. loadConfig has
 * already validated that agentDir stays under `dir`.
 */
export function resolveAgentDir(dir: string, config: FastagentConfig): string {
  return resolve(dir, config.agentDir ?? ".");
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
 * Resolve a user-supplied path override (a CLI flag or an env var) to an absolute path, expanding a
 * leading `~`/`~/` to the home dir FIRST. Path-valued config from `.env` (or any non-shell source)
 * never gets the shell's `~` expansion, so a bare `resolve("~/x")` would silently create a literal `~`
 * directory — a fail-silently footgun for a secret/state path. Expanding here makes `~` mean home
 * everywhere these knobs are read.
 */
function resolveOverridePath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return resolve(expanded);
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

/**
 * The IN-TREE default state root, `<dir>/.fastagent` — what {@link resolveStateRoot} falls back to when
 * `FASTAGENT_STATE_DIR` moves state nowhere. THE single definition of that path segment.
 */
export function projectStateDir(dir: string): string {
  return join(dir, ".fastagent");
}

/**
 * The resolved state root — the ONE durable machine-state home everything derives from (auth.json,
 * sessions/, channels/<kind>/): `FASTAGENT_STATE_DIR` env > `<dir>/.fastagent`. Absolute, so channels
 * and the startup report agree regardless of cwd. Definition: single lifecycle (precious, survives
 * redeploy), single process — a container mounts ONE volume here. The finer knobs
 * (`FASTAGENT_SESSIONS_DIR`, `FASTAGENT_AUTH_PATH`) still override their specific path on top.
 *
 * `FASTAGENT_STATE_DIR` is an OPERATOR override, so a relative value resolves against `process.cwd()`
 * — the CLI convention its sibling knobs share (`resolveOverridePath`), NOT against `dir`. Only the
 * DEFAULT (`<dir>/.fastagent`) is dir-anchored. Deployments set an absolute path (a mounted volume);
 * a relative value is in-tree — hence self-ignored — only when run from the definition dir (cwd == dir).
 */
export function resolveStateRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_STATE_DIR) ?? resolve(projectStateDir(dir));
}

/** The default credentials file under a resolved state root ({@link resolveStateRoot}). */
export function defaultAuthPath(stateRoot: string): string {
  return join(stateRoot, "auth.json");
}

/** The effective auth file for a workspace: override if present, else the project-level auth.json. */
export function resolveAuthPath(dir: string, flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return resolveAuthPathOverride(flag, env) ?? defaultAuthPath(resolveStateRoot(dir, env));
}

/** The default sessions dir under a resolved state root ({@link resolveStateRoot}). */
export function defaultSessionsDir(stateRoot: string): string {
  return join(stateRoot, "sessions");
}
