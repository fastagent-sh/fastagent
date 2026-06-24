/**
 * The config subsystem: schema (defineConfig), loading (loadConfig), and
 * interpretation of config values (resolveModelSpec for source precedence,
 * resolveModel for the `model` string). One concern: everything about
 * fastagent.config.ts, nothing else.
 *
 * fastagent.config.ts — layer 2 of the three-layer workspace (production source):
 * deployment/assembly choices. Checked into git; secrets go in .env.
 *
 * v1 keys (each passes the "explainable in one sentence + has a near-term story" bar):
 *   - model:    which LLM ("provider/modelId" string — serializable; a repo default overridden by env/CLI);
 *   - tools:    extra custom tools, appended after pi's default tools;
 *   - http:     serving options for the built-in HTTP channel (bind port).
 *
 * The deployment's inbound surface (webhook channels) is NOT a config key: a channel always needs
 * app glue (its `on()` handler), so it is authored as a file under `channels/` (discovered like
 * `tools/`), never listed inline. Absent any channel = the default invoke channel at POST /invoke.
 *
 * Deliberately NOT in v1 (kept as library-API escape hatches):
 *   - sessions/env backend selection — K axis; the hosting knife shapes it from real backends;
 *   - base/auth/skillPaths overrides — the defaults are almost always right; putting them
 *     in config invites misuse.
 *
 * Red line: config describes "choices for this deployment", never the agent's identity
 * or behavior (that lives in AGENTS.md + skills). Deleting the config must still leave
 * a runnable zero-config agent (model via --model / FASTAGENT_MODEL).
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getModel, getModels, getProviders } from "@earendil-works/pi-ai";
import type { AnyModel } from "./harness.ts";

export interface FastagentConfig {
  /** "provider/modelId", e.g. "openai-codex/gpt-5.5". Precedence: CLI --model > FASTAGENT_MODEL > config. */
  model?: string;
  /** Extra custom tools, appended after pi defaults — never replaces them (materialized by resolveTools in create.ts). */
  tools?: AgentTool[];
  /** Built-in HTTP channel options. */
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

/**
 * Load `<dir>/fastagent.config.ts|.js|.mjs`. No file = zero-config ({});
 * a file with the wrong shape throws (fail visibly).
 */
export async function loadConfig(dir: string): Promise<LoadedConfig> {
  const names = ["fastagent.config.ts", "fastagent.config.js", "fastagent.config.mjs"];
  const found = names.map((name) => join(dir, name)).filter((path) => existsSync(path));
  if (found.length === 0) return { config: {} };
  if (found.length > 1) {
    throw new Error(
      `${dir}: multiple fastagent config files found; keep exactly one (${found.map((p) => basename(p)).join(", ")})`,
    );
  }

  // Exactly one config file at this point (0 and >1 handled above).
  // biome-ignore lint/style/noNonNullAssertion: length checked above — exactly one element here
  const path = found[0]!;
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const config = mod.default;
  if (!config || typeof config !== "object") {
    throw new Error(`${path}: must default-export defineConfig({...})`);
  }
  const c = config as FastagentConfig;
  // Unknown keys throw: defineConfig only type-protects .ts authors; a typo in a
  // .js/.mjs config (`modle:`) must not silently degrade to zero-config.
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
  // Same typo discipline one level down: { http: { porrt } } must not silently
  // fall back to the default port.
  for (const key of Object.keys(c.http ?? {})) {
    if (key !== "port") {
      throw new Error(`${path}: unknown key "http.${key}" (valid keys: port)`);
    }
  }
  if (
    c.http?.port !== undefined &&
    (typeof c.http.port !== "number" || !Number.isInteger(c.http.port) || c.http.port < 0 || c.http.port > 65535)
  ) {
    throw new Error(`${path}: "http.port" must be an integer 0-65535`);
  }
  return { config: c, path };
}

/** Resolve "provider/modelId" → a pi Model. Unknown specs throw a clear error (getModel returns undefined). */
export function resolveModel(spec: string): AnyModel {
  const slash = spec.indexOf("/");
  if (slash < 1 || slash === spec.length - 1) {
    throw new Error(`model must be "provider/modelId" (e.g. "openai-codex/gpt-5.5"), got "${spec}"`);
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const model = getModel(provider as never, modelId as never) as AnyModel | undefined;
  if (!model) {
    throw new Error(
      `unknown model "${spec}" (provider "${provider}" / id "${modelId}" not in registry); run \`fastagent models\` to list available specs`,
    );
  }
  return model;
}

/**
 * All registered "provider/modelId" specs, sorted — the discovery list behind `fastagent models`.
 * Sourced from pi-ai's registry (getProviders × getModels), so it stays in sync with what
 * {@link resolveModel} accepts. Pure (no IO); the CLI prints it to stdout.
 */
export function listModels(): string[] {
  const specs: string[] = [];
  for (const provider of getProviders()) {
    for (const model of getModels(provider)) specs.push(`${provider}/${model.id}`);
  }
  return specs.sort();
}

/** Model selection precedence: CLI flag > FASTAGENT_MODEL env var > config default. All absent = undefined (caller errors). */
export function resolveModelSpec(
  flag: string | undefined,
  config: FastagentConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return flag ?? env.FASTAGENT_MODEL ?? config.model;
}
