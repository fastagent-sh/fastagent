/**
 * Build: compile a workspace for serving (core-design §10.3, container tier).
 *
 * v1 targets the container packaging tier: the deployable IS the project (the whole
 * source tree ships in the image), so build does NOT produce a separate, stripped
 * artifact. Instead it:
 *   1. validates the workspace (config + model + definition) so a broken agent fails
 *      at build, not at the first request;
 *   2. freezes the resolved deployment choices (model + http) into a manifest the
 *      runtime reads.
 *
 * Build is non-destructive: it only writes machine state under `.fastagent/` and never
 * touches the source tree. Authored context (root-level files the agent reads on
 * demand, §10.1a) therefore ships intact because nothing is stripped — `start` runs
 * in the project, where those files live.
 *
 * The relocatable, source-tree-bundling artifact (with the secret/dep exclusion
 * boundary) is the portable tier — deferred to the AgentCore target adapter.
 * `bundleAgentDefinition` remains the primitive for that tier; the v1 build path does
 * not use it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type FastagentConfig, loadConfig, resolveModel, resolveModelSpec } from "./config.ts";
import { type LoadedDefinition, loadAgentDefinition } from "./definition.ts";

/** The build manifest written to `.fastagent/manifest.json`. Pure data (no `.ts`). */
export interface BuildManifest {
  fastagentVersion: string;
  engine: "pi";
  /** ISO timestamp; provenance, not a reproducibility key. */
  builtAt: string;
  /** Resolved "provider/modelId" frozen at build = the runtime default (overridable by --model/FASTAGENT_MODEL at start). */
  model: string;
  /** Serving options carried from config.http (present only when configured). */
  http?: FastagentConfig["http"];
}

export interface BuildPiWorkspaceOptions {
  /** Model spec override. Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
}

const STATE_DIR = ".fastagent";
const MANIFEST_FILE = "manifest.json";

/**
 * Compile {@link dir} for serving: validate config + model + definition, then write
 * `.fastagent/manifest.json`. Non-destructive (only writes under `.fastagent/`).
 * Throws a clear error on a missing/unknown model or a broken definition.
 */
export async function buildPiWorkspace(
  dir: string,
  options: BuildPiWorkspaceOptions = {},
): Promise<{ manifest: BuildManifest; definition: LoadedDefinition }> {
  const { config } = await loadConfig(dir);
  const model = resolveModelSpec(options.model, config);
  if (!model) {
    throw new Error(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
    );
  }
  // Validate against the registry now, so a typo fails the build instead of being
  // frozen into the manifest and only failing later at start (dev fails fast too).
  resolveModel(model);
  // Validate the definition loads (definition-only: the agent is its folder). This
  // surfaces a broken AGENTS.md / skills at build; it does not copy anything.
  const definition = await loadAgentDefinition(dir, { skillPaths: [] });

  const stateDir = join(dir, STATE_DIR);
  await mkdir(stateDir, { recursive: true });
  // Self-gitignore the state dir (same as the L3 workspace rung) so a build on a clean
  // checkout does not leave `.fastagent/` to be committed.
  await writeFile(join(stateDir, ".gitignore"), "*\n", { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const manifest: BuildManifest = {
    fastagentVersion: await readFastagentVersion(),
    engine: "pi",
    builtAt: new Date().toISOString(),
    model,
    ...(config.http ? { http: config.http } : {}),
  };
  await writeFile(join(stateDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, definition };
}

/** Read this package's version for manifest provenance (best-effort; defaults if unreadable). */
async function readFastagentVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
