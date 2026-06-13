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
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
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

  // fastagent.json is the manifest's reserved name. A source file by that name at the
  // artifact root would be overwritten by the manifest, silently changing what the agent
  // reads at runtime. Reject it HERE — before the destructive bundle step — so a rebuild
  // never destroys a prior good artifact (or poisons outDir) over a collision. The name
  // has no legitimate source use (config lives in fastagent.config.ts/js/mjs).
  if (await stat(join(resolve(srcDir), MANIFEST_FILE)).then(() => true, () => false)) {
    throw new Error(
      `"${MANIFEST_FILE}" is reserved for the build manifest; the source has a file by that name ` +
        `at its root — rename it (config goes in fastagent.config.ts/js/mjs)`,
    );
  }

  // bundleAgentDefinition does `rm -rf outDir`. Its realpath guards block the
  // catastrophic cases (out == src / out contains src), but an in-tree `--out docs`
  // or `--out skills` points at EXISTING authored content that rm would destroy. Only
  // own an out dir that is safe to replace: under `.fastagent/`, non-existent, empty,
  // or a prior artifact. "Prior artifact" is validated by the manifest's CONTENT, not
  // just a file named fastagent.json — a user's authored sample by that name must not
  // license deleting their directory. Otherwise refuse; the source is untouched.
  // "Owned" is the build dir specifically (.fastagent/build), NOT all of .fastagent —
  // .fastagent/sessions holds session history that an --out there would rm.
  const outResolved = resolve(outDir);
  const ownedBuild = join(resolve(srcDir), ".fastagent", "build");
  const underOwned = outResolved === ownedBuild || outResolved.startsWith(ownedBuild + sep);
  if (!underOwned) {
    const entries = await readdir(outResolved).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as string[];
      throw e;
    });
    if (entries.length > 0 && !(await isPriorArtifact(outResolved))) {
      throw new Error(
        `--out "${outDir}" is not empty and not a prior fastagent artifact; refusing to overwrite it ` +
          `(use an empty dir, a previous build dir, or the default .fastagent/build)`,
      );
    }
  }

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

/**
 * Whether outDir holds a real fastagent artifact (its manifest validates), so a rebuild
 * may safely replace it. Validated by CONTENT, not the filename: a user's authored file
 * coincidentally named fastagent.json must not license deleting their directory.
 */
async function isPriorArtifact(outDir: string): Promise<boolean> {
  try {
    const m = JSON.parse(await readFile(join(outDir, MANIFEST_FILE), "utf8")) as Partial<ArtifactManifest>;
    return (
      m.engine === "pi" &&
      typeof m.fastagentVersion === "string" &&
      typeof m.builtAt === "string" &&
      typeof m.model === "string"
    );
  } catch {
    return false; // missing / unreadable / not our shape
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
