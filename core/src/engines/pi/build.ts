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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /**
   * Allow an outDir OUTSIDE the source tree. Publishing replaces outDir wholesale, so an
   * out-of-tree path is the place a typo (`--out /home/me`) nukes unrelated data. Default
   * false: refuse such a path unless explicitly confirmed (cf. Vite's emptyOutDir).
   */
  force?: boolean;
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
  // realpath both through the SAME symlinks (a not-yet-existing outDir is resolved via its
  // nearest existing ancestor), so e.g. macOS /var vs /private/var does not make an in-tree
  // target look out-of-tree.
  const srcReal = await realpathBase(srcDir);
  const outReal = await realpathBase(finalDir);
  if (srcReal === outReal) {
    throw new Error(`build output dir must differ from the source workspace (got "${outDir}")`);
  }
  const outToSrc = relative(outReal, srcReal); // src relative to out; ""/".."-prefixed/absolute = not contained
  if (outToSrc !== "" && outToSrc !== ".." && !outToSrc.startsWith(".." + sep) && !isAbsolute(outToSrc)) {
    throw new Error(`build output dir must not contain the source workspace (got out="${outDir}")`);
  }
  // Location guardrail (not a content judgment): publishing REPLACES outDir wholesale, so an
  // out-of-tree target is where a path typo deletes unrelated data. Allow a target inside the
  // source tree freely; require explicit confirmation (force) for one outside it.
  const srcToOut = relative(srcReal, outReal); // out relative to src; ".."-prefixed/absolute = outside
  const outsideSource = srcToOut === ".." || srcToOut.startsWith(".." + sep) || isAbsolute(srcToOut);
  if (outsideSource && !options.force) {
    throw new Error(
      `build output dir is outside the source workspace (got "${outDir}"); it will be REPLACED wholesale — ` +
        `pass --force to confirm building there`,
    );
  }

  // Build into a fresh STAGING dir, same filesystem as the target so the publish rename is
  // atomic, and never reachable by the walk so a crash-orphaned staging can't ship:
  //   - in-tree target  → under <src>/.fastagent/ (already hard-excluded from the walk);
  //   - out-of-tree target → sibling of finalDir (outside the source tree, so not walked).
  const stagingParent = outsideSource ? dirname(finalDir) : join(srcReal, ".fastagent");
  await mkdir(dirname(finalDir), { recursive: true });
  await mkdir(stagingParent, { recursive: true });
  const staging = await mkdtemp(join(stagingParent, ".fa-build-"));
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

/**
 * realpath a path that may not exist yet: resolve the deepest existing ancestor through
 * symlinks, then re-append the non-existent tail. So two paths under the same real root
 * compare consistently even when the target has not been created.
 */
async function realpathBase(p: string): Promise<string> {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    const real = await realpath(cur).catch(() => undefined);
    if (real !== undefined) return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    const parent = dirname(cur);
    if (parent === cur) return resolve(p); // reached the root without resolving
    tail.push(basename(cur));
    cur = parent;
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
