/**
 * Build: compile a workspace into a self-contained, relocatable artifact
 * (core-design §10.1/§10.3). Build-time only — uses node:fs directly (it runs on the
 * build machine by definition).
 *
 * The artifact is a directory that does NOT depend on the source location: it holds
 * the cleaned source tree (AGENTS.md, skills/, authored context, fastagent.config.ts,
 * tool source, package.json, …) with the machine's opted-in global skills materialized
 * into skills/, plus a `fastagent.json` manifest. Secrets/deps/vcs/machine-state are
 * excluded (see bundleAgentDefinition); npm-dependent code tools get their deps via a
 * `npm ci` at deploy. `start` runs from the artifact alone.
 *
 * Build is non-destructive to the source: it only writes the (separate) outDir.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
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
  /** Materialize the machine's global skills into the artifact's skills/. Default false (definition-only). */
  globalSkills?: boolean;
}

const MANIFEST_FILE = "fastagent.json";

/**
 * Compile {@link srcDir} into a self-contained artifact at {@link outDir}. Resolves +
 * validates the model (fails visibly if missing/unknown), materializes the cleaned
 * source tree + opted-in globals (bundleAgentDefinition), and writes the manifest into
 * the artifact. Non-destructive to the source; only outDir is written/replaced.
 */
export async function buildPiArtifact(
  srcDir: string,
  outDir: string,
  options: BuildPiArtifactOptions = {},
): Promise<{ manifest: ArtifactManifest; definition: LoadedDefinition; outDir: string }> {
  const { config } = await loadConfig(srcDir);
  const model = resolveModelSpec(options.model, config);
  if (!model) {
    throw new Error(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
    );
  }
  // Validate against the registry now (before touching outDir), so a typo fails the
  // build instead of being frozen into the manifest and only failing later at start.
  resolveModel(model);

  const definition = await bundleAgentDefinition(srcDir, outDir, {
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
    const pkgPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
