/**
 * Build: compile a workspace into a self-contained, inspectable artifact
 * (core-design §10.3). Build-time only — uses node:fs directly (it runs on the
 * build machine by definition).
 *
 * The artifact is a directory holding the materialized definition
 * (AGENTS.md + skills/, via bundleAgentDefinition) plus a `fastagent.json`
 * manifest that freezes the resolved deployment choices the runtime needs
 * (model + http). The skill list is NOT duplicated into the manifest — the
 * `skills/` directory is the single source of truth.
 *
 * Code tools are not represented here: they are functions in fastagent.config.ts,
 * not serializable data. The manifest carries model + http only; an agent that
 * uses code tools runs from the project (the container packaging tier, §10.2),
 * not from a relocatable manifest-only artifact.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type FastagentConfig, loadConfig, resolveModel, resolveModelSpec } from "./config.ts";
import { type LoadedDefinition, bundleAgentDefinition, defaultGlobalSkillPaths } from "./definition.ts";

/** The `fastagent.json` manifest written into the artifact. Pure data (no `.ts`). */
export interface ArtifactManifest {
  fastagentVersion: string;
  engine: "pi";
  /** ISO timestamp; provenance, not a reproducibility key. */
  builtAt: string;
  /** Resolved "provider/modelId" frozen at build = the runtime default (overridable by --model/FASTAGENT_MODEL at start). */
  model: string;
  /** Serving options carried from config.http (present only when configured). */
  http?: FastagentConfig["http"];
}

export interface BuildPiArtifactOptions {
  /** Model spec override. Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
  /** Materialize the machine's global skills into the artifact. Default false (definition-only). */
  globalSkills?: boolean;
}

const MANIFEST_FILE = "fastagent.json";

/**
 * Compile {@link workspaceDir} into a deployable artifact at {@link outDir}.
 * Resolves + freezes the model (fails visibly if none is set), materializes the
 * definition, and writes the manifest. Deterministic: bundleAgentDefinition cleans
 * the outputs it owns (AGENTS.md, skills/) and the manifest is overwritten; nothing
 * else in outDir is touched.
 */
export async function buildPiArtifact(
  workspaceDir: string,
  outDir: string,
  options: BuildPiArtifactOptions = {},
): Promise<{ manifest: ArtifactManifest; definition: LoadedDefinition; outDir: string }> {
  const { config } = await loadConfig(workspaceDir);
  const model = resolveModelSpec(options.model, config);
  if (!model) {
    throw new Error(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
    );
  }
  // Validate against the registry now (before touching outDir), so a typo fails the
  // build instead of being frozen into the manifest and only failing later at start.
  // dev fails fast on the same typo; build must match. Only the throw matters here.
  resolveModel(model);
  const definition = await bundleAgentDefinition(workspaceDir, outDir, {
    skillPaths: options.globalSkills ? defaultGlobalSkillPaths() : [],
  });
  const manifest: ArtifactManifest = {
    fastagentVersion: await readFastagentVersion(),
    engine: "pi",
    builtAt: new Date().toISOString(),
    model,
    ...(config.http ? { http: config.http } : {}),
  };
  await writeFile(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, definition, outDir };
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
