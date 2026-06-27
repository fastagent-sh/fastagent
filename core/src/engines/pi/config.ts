/**
 * The config subsystem: schema (defineConfig), loading (loadConfig), and value interpretation
 * (resolveModel, resolveModelSpec). One concern: everything about fastagent.config.ts.
 *
 * Red line: config describes "choices for this deployment" (model / extra tools / http port), never
 * the agent's identity or behavior (that lives in AGENTS.md + skills). Deleting the config must
 * still leave a runnable zero-config agent (model via --model / FASTAGENT_MODEL).
 */
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import type { AnyModel } from "./harness.ts";
import { moduleLoadHint } from "./loader.ts";

export interface FastagentConfig {
  /** "provider/modelId". Precedence: CLI --model > FASTAGENT_MODEL > config. */
  model?: string;
  /** Extra custom tools, appended after pi defaults — never replaces them. */
  tools?: AgentTool[];
  http?: { port?: number };
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

/** Load `<dir>/fastagent.config.ts|.js|.mjs`. No file = zero-config; a wrong-shape file throws. */
export async function loadConfig(dir: string): Promise<LoadedConfig> {
  const names = ["fastagent.config.ts", "fastagent.config.js", "fastagent.config.mjs"];
  const found = names.map((name) => join(dir, name)).filter((path) => existsSync(path));
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
    mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
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
    if (key !== "model" && key !== "tools" && key !== "http") {
      throw new Error(`${path}: unknown key "${key}" (valid keys: model, tools, http)`);
    }
  }
  if (c.model !== undefined && typeof c.model !== "string") {
    throw new Error(`${path}: "model" must be a "provider/modelId" string`);
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
  return { config: c, path };
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
 * (the opener then falls back to `<dir>/.fastagent/sessions`). Resolved to absolute so the store and
 * the startup report agree regardless of cwd.
 */
export function resolveSessionsDirOverride(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = flag ?? env.FASTAGENT_SESSIONS_DIR;
  return raw ? resolve(raw) : undefined;
}
