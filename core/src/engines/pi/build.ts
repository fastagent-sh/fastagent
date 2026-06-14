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
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
 * validates the model, builds the whole artifact into a fresh STAGING dir, then PUBLISHES
 * it atomically over outDir. The target is never touched until a complete artifact is
 * staged, so a failure mid-build leaves it untouched; and the artifact appears in one
 * atomic step (no half-written / poisoned target).
 *
 * outDir is regenerable build output: an existing target is replaced unconditionally. The
 * one guard is structural — outDir must not be, contain, or equal the source (you cannot
 * publish the artifact over the input you are reading). Non-destructive to the source.
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
  // Validate against the registry now, so a typo fails the build instead of being frozen
  // into the manifest and only failing later at start.
  resolveModel(model);

  // Structural guard (the ONLY one): the output must not be the source or contain it — we
  // read src and publish over outDir, so out ⊇ src would destroy the input. realpath so a
  // symlink alias is caught; resolve fallback when outDir does not exist yet. (Whether an
  // EXISTING target is "precious" is not our call: outDir is regenerable build output.)
  const finalDir = resolve(outDir);
  const srcReal = await realpath(srcDir).catch(() => resolve(srcDir));
  const outReal = await realpath(finalDir).catch(() => finalDir);
  if (srcReal === outReal) {
    throw new Error(`build output dir must differ from the source workspace (got "${outDir}")`);
  }
  const outToSrc = relative(outReal, srcReal); // src relative to out; ""/".."-prefixed/absolute = not contained
  if (outToSrc !== "" && outToSrc !== ".." && !outToSrc.startsWith(".." + sep) && !isAbsolute(outToSrc)) {
    throw new Error(`build output dir must not contain the source workspace (got out="${outDir}")`);
  }

  // Build into a fresh STAGING dir that is a sibling of outDir (same filesystem → the
  // publish rename is atomic). bundle skips both staging and finalDir so neither is walked
  // into the artifact when outDir lives inside the source tree.
  await mkdir(dirname(finalDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(finalDir), ".fa-build-"));
  try {
    const definition = await bundleAgentDefinition(
      srcDir,
      staging,
      { skillPaths: options.globalSkills ? defaultGlobalSkillPaths() : [] },
      { reservedRootFile: MANIFEST_FILE, skipPaths: [finalDir] },
    );
    const manifest: ArtifactManifest = {
      fastagentVersion: await readFastagentVersion(),
      engine: "pi",
      builtAt: new Date().toISOString(),
      model,
      ...(config.http ? { http: config.http } : {}),
    };
    await writeFile(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    // Publish: the destructive replace happens ONLY now, after a complete artifact is
    // staged. rm is a no-op when finalDir is absent.
    await rm(finalDir, { recursive: true, force: true });
    await rename(staging, finalDir);
    return { manifest, definition, outDir };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }); // failure leaves no partial staging
    throw error;
  }
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
