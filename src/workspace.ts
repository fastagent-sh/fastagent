/**
 * Workspace path/ignore utilities — engine-neutral (pure fs/path + the `ignore` matcher). Shared by the
 * scaffold (init/add) and the engine's channel discovery, so they live here, not under engines/pi.
 * Also the home of the MACHINERY path resolution (`.state`/`.secrets` + their env overrides): env.ts
 * (the `.env` reader, neutral) and engines/pi/config.ts (which re-exports the public names) both
 * derive from it, so "where does machinery live" has ONE owner without pulling engine code into
 * neutral modules.
 */
import { realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";

/** The fixed name of a standalone workspace directory (and of the user-global machinery home `~/.fastagent`). */
export const STANDALONE_DIR = ".fastagent";

/**
 * Resolve a user-supplied path override (a CLI flag or an env var) to an absolute path, expanding a
 * leading `~`/`~/` to the home dir FIRST. Path-valued config from `.env` (or any non-shell source)
 * never gets the shell's `~` expansion, so a bare `resolve("~/x")` would silently create a literal `~`
 * directory — a fail-silently footgun for a secret/state path. Expanding here makes `~` mean home
 * everywhere these knobs are read.
 */
export function resolveOverridePath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return resolve(expanded);
}

/**
 * The machinery home for a workspace root: the root itself — EXCEPT when the root is the user's HOME
 * directory (`fastagent login` run from `~`): machinery then lives under the user-global
 * `~/.fastagent/` (so `~/.secrets` / `~/.state` are never created). The global home carries the same
 * unified shape inside it (`~/.fastagent/.secrets/auth.json` — GLOBAL_AUTH_PATH in auth.ts).
 * Canonical comparison: `dir` arrives realpath-resolved (process.cwd()), homedir() may be a symlink.
 */
function machineryHome(dir: string): string {
  const canonical = (p: string): string => {
    try {
      return realpathSync(resolve(p));
    } catch {
      return resolve(p);
    }
  };
  return canonical(dir) === canonical(homedir()) ? join(resolve(dir), STANDALONE_DIR) : resolve(dir);
}

/**
 * The resolved state root — the durable machine-state home (sessions/, channels/<kind>/, schedule/,
 * control.json): `FASTAGENT_STATE_DIR` env > `<workspaceRoot>/.state`. Absolute, so channels and the
 * startup report agree regardless of cwd. Definition: mutable runtime state — single lifecycle
 * (precious, survives redeploy), single process; a container points this at its mounted volume.
 * Secrets are NOT here — they live under {@link resolveSecretsDir} (a different deploy lifecycle:
 * secret store vs volume). The finer knob (`FASTAGENT_SESSIONS_DIR`) still overrides its path on top.
 *
 * `FASTAGENT_STATE_DIR` is an OPERATOR override, so a relative value resolves against `process.cwd()`
 * — the CLI convention its sibling knobs share (`resolveOverridePath`), NOT against `dir`. Only the
 * DEFAULT (`<root>/.state`) is dir-anchored.
 */
export function resolveStateRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_STATE_DIR) ?? join(machineryHome(dir), ".state");
}

/**
 * The resolved secrets dir — everything fastagent manages that must NEVER leave the machine (the
 * workspace `.env` + auth.json): `FASTAGENT_SECRETS_DIR` env > `<workspaceRoot>/.secrets`. Split from
 * the state root on deploy lifecycle: secrets travel through the host's secret store (env vars / the
 * auth seed), state through a volume. A deployed box sets both env knobs at its volume (e.g.
 * `/data/.secrets`, `/data/.state`) so a seeded-then-ROTATED OAuth credential persists across
 * restarts. The `.env`'s OWN location resolves from the REAL environment — commands locate and load
 * `.env` before anything else, so a `FASTAGENT_SECRETS_DIR` set INSIDE `.env` still relocates
 * auth.json but cannot move the file it is read from (env.ts dotEnvPath).
 */
export function resolveSecretsDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_SECRETS_DIR) ?? join(machineryHome(dir), ".secrets");
}

/**
 * Guard that `<workspaceDir>/<name>` resolves INSIDE the workspace — a symlink that escapes (or an
 * absolute target) is rejected, so discovery/scaffolding never reaches out of the definition directory.
 * A missing target is fine (nothing to guard yet).
 */
export async function assertInsideWorkspace(workspaceDir: string, name: string): Promise<void> {
  const target = join(workspaceDir, name);
  const real = await realpath(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "not_found") return undefined;
    throw e;
  });
  if (real === undefined) return;
  const root = await realpath(workspaceDir).catch(() => resolve(workspaceDir));
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `${target} resolves outside the workspace (${real}) — it must live inside the definition directory; ` +
        `use a real directory or a symlink that stays within it`,
    );
  }
}

/** Load `.gitignore` + `.fastagentignore` from `dir` into one matcher (case-sensitive), or undefined if none. */
export async function loadRootIgnore(dir: string): Promise<Ignore | undefined> {
  let rules = "";
  for (const name of [".gitignore", ".fastagentignore"]) {
    try {
      rules += `\n${await readFile(join(dir, name), "utf8")}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`cannot read ${join(dir, name)}: ${(error as Error).message}`);
      }
    }
  }
  // ignorecase:false — the library defaults to case-INSENSITIVE, which would make a rule `README.md`
  // also drop an authored `readme.md`. Match git on a case-sensitive filesystem, reproducibly.
  return rules.trim() === "" ? undefined : ignore({ ignorecase: false }).add(rules);
}
