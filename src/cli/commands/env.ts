/** `fastagent env <mise args…>`: the agent's own mise, run in the agent directory on its `mise.toml` alone. */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import {
  type DeclaredEnvironment,
  MISE_FILE,
  MISE_LOCK_FILE,
  MISE_LOCK_SIDECARS,
  missingToolchains,
  readEnvironment,
  toolchainAdvice,
} from "../../environment/declare.ts";
import { log } from "../../log.ts";
import lockfile from "proper-lockfile";
import { ensureMise, execMise } from "../../environment/mise.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";

/** The files mise writes for the agent. */
const WRITTEN = [MISE_FILE, MISE_LOCK_FILE] as const;

/** What the agent's environment was before a command: the files, and a copy of the lock's sidecars, if any. */
interface Snapshot {
  files: (string | undefined)[];
  sidecars?: string;
}

export async function runEnv(args: string[]): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
  const { code, environment, refusal } = await oneAtATime(agentDir, async () => {
    const bin = await ensureMise(agentDir);
    const before = takeSnapshot(agentDir);
    try {
      return { code: await execMise(agentDir, bin, args), ...undoIfRefused(agentDir, before) };
    } finally {
      if (before.sidecars) rmSync(before.sidecars, { recursive: true, force: true });
    }
  }).catch(failStartup);
  if (refusal) failStartup(refusal);
  // Said by the command that declared them, before an image build is the first to fail on it.
  for (const group of environment ? missingToolchains(environment) : []) {
    log.warn(`[fastagent] ${toolchainAdvice(group)}`);
  }
  if (code !== 0) process.exit(code);
}

/**
 * One `fastagent env` at a time per agent, whose sessions each run their own: a refused command puts back what it
 * found, which would take another command's change made meanwhile with it. The lock is the directory proper-lockfile
 * keeps beside `mise.toml` (`mise.toml.lock`), refreshed while it is held, so a command waits out another's install.
 */
async function oneAtATime<T>(agentDir: string, run: () => Promise<T>): Promise<T> {
  const path = join(agentDir, MISE_FILE);
  let compromised: Error | undefined;
  // `realpath: false`: mise.toml may not exist yet.
  const options = { realpath: false, stale: 30_000, onCompromised: (error: Error) => (compromised = error) };
  const release = await lockfile.lock(path, options).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ELOCKED") throw error;
    log.info("[fastagent] waiting for another `fastagent env` on this agent to finish");
    return lockfile.lock(path, { ...options, retries: { forever: true, minTimeout: 200, maxTimeout: 2_000 } });
  });
  let result: T;
  try {
    result = await run();
  } catch (error) {
    // The primary failure is the one to report; a lock that cannot be released cleanly then is secondary.
    await release().catch(() => {});
    throw error;
  }
  // A compromised lock cannot be released cleanly; that, not the release, is what to report.
  await release().catch((error: unknown) => {
    if (!compromised) throw error;
  });
  if (compromised) throw compromised;
  return result;
}

/**
 * Checked by the command that wrote it, and undone: mise writes what FastAgent refuses too (`set` writes [env]), and a
 * refused file left in place stops the next start, which on a host only a new release repairs. The agent runs this
 * command on itself. A file refused before the command is reported as it is.
 */
function undoIfRefused(agentDir: string, before: Snapshot): { environment?: DeclaredEnvironment; refusal?: Error } {
  try {
    return { environment: readEnvironment(agentDir) };
  } catch (error) {
    const changed = WRITTEN.filter((name, i) => readIfPresent(join(agentDir, name)) !== before.files[i]);
    if (changed.length === 0) return { refusal: error as Error };
    restoreSnapshot(agentDir, before);
    const message = `${(error as Error).message} — this command's change to ${changed.join(" and ")} is undone`;
    return { refusal: new Error(message) };
  }
}

function takeSnapshot(agentDir: string): Snapshot {
  const files = WRITTEN.map((name) => readIfPresent(join(agentDir, name)));
  const sidecars = join(agentDir, MISE_LOCK_SIDECARS);
  if (!existsSync(sidecars)) return { files };
  const copy = mkdtempSync(join(tmpdir(), "fastagent-env-"));
  cpSync(sidecars, copy, { recursive: true });
  return { files, sidecars: copy };
}

/** The sidecars go back with the lock: it names them by digest. */
function restoreSnapshot(agentDir: string, before: Snapshot): void {
  for (const [i, name] of WRITTEN.entries()) {
    const path = join(agentDir, name);
    const content = before.files[i];
    if (content === undefined) rmSync(path, { force: true });
    else writeFileAtomic(path, content);
  }
  const sidecars = join(agentDir, MISE_LOCK_SIDECARS);
  rmSync(sidecars, { recursive: true, force: true });
  if (before.sidecars) cpSync(before.sidecars, sidecars, { recursive: true });
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
