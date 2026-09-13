/**
 * THE refusal: file-backed agent state has ONE writer.
 *
 * The session store is an append-structured journal and the channel/schedule files are whole-file rewrites, so two
 * processes over one directory interleave entries and lose each other's updates. Nothing in the shipped tier
 * coordinates that — the per-invoke session lease is an in-memory Set, which a second process does not share — so
 * the ordinary way into the unsupported topology is two ordinary commands (`dev` serving while `fire` runs the same
 * `schedule:<name>` conversation, two `start`s on different ports over one directory).
 *
 * This is that guard, at the one place a writable store is opened. It covers the RESOLVED write paths rather than
 * the nominal state root: a run pointed at another sessions directory must contend on THAT directory.
 *
 * The deployed path has its own, coarser lease (`leaseDeployment` — one process per mounted volume, `flock`, held
 * for the process lifetime). Both can hold at once; they answer different questions.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { log } from "./log.ts";

/** The lock target inside each guarded directory (so its `.lock` sibling also lands there, not beside the agent). */
const LOCK_FILE = "writer.lock";

/**
 * How long a holder that died without releasing keeps the directory. `proper-lockfile` touches the lock while the
 * process lives, so this bounds only a crash — a normal exit releases below.
 */
const STALE_MS = 15_000;

/**
 * A short retry, for the one case that is not a real conflict: a manual restart racing the outgoing process's exit.
 * `dev`'s supervisor already respawns only after its worker exited, so this stays ~1s rather than a wait that makes
 * a genuine second writer look like a hang.
 */
const RETRIES = { retries: 3, factor: 3, minTimeout: 100, maxTimeout: 600, randomize: true };

/** Held by THIS process, so the exit handler is registered once rather than per acquisition. */
const held = new Set<string>();
let exitHandlerInstalled = false;

function releaseOnExit(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  // Sync, because `exit` is the only hook a process.exit() path still runs. Without it the next start would have to
  // wait out STALE_MS — which is exactly what `dev`'s restart-on-edit loop would do, on every edit.
  process.once("exit", () => {
    for (const target of held) {
      try {
        lockfile.unlockSync(target, { realpath: false });
      } catch {
        // The lock goes stale on its own; an exit handler has nowhere left to report to.
      }
    }
  });
}

/**
 * Take write ownership of every given directory, or refuse with what holds it and the ways out.
 *
 * The returned release is for a caller that outlives its agent (tests, an embedder unmounting a service); a CLI
 * command just exits.
 */
export async function lockAgentState(dirs: readonly string[]): Promise<() => Promise<void>> {
  const targets = [...new Set(dirs.map((dir) => join(resolve(dir), LOCK_FILE)))];
  const taken: string[] = [];
  const release = async (): Promise<void> => {
    for (const target of taken.splice(0)) {
      held.delete(target);
      await lockfile
        .unlock(target, { realpath: false })
        .catch((error: unknown) =>
          log.warn(`[fastagent] could not release the state lock ${target}: ${String(error)}`),
        );
    }
  };
  for (const target of targets) {
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, "", { flag: "a" }); // proper-lockfile locks an EXISTING path
    try {
      await lockfile.lock(target, {
        realpath: false,
        stale: STALE_MS,
        retries: RETRIES,
        // The lock directory vanished under us (someone cleared the state root). Default behaviour rethrows from a
        // timer, which takes the process down over a guard; the ownership is genuinely lost either way, so say so
        // and keep serving — the work in flight is what the guard exists to protect.
        onCompromised: (error) =>
          log.warn(`[fastagent] the state lock ${target} was lost — another process could now write: ${String(error)}`),
      });
    } catch (error) {
      await release();
      if ((error as { code?: string }).code !== "ELOCKED") throw error;
      throw new Error(
        `another process is already writing this agent's state (${target}) — file-backed state has one writer, ` +
          `and a second one interleaves session journals and drops channel state. Ask the running service instead ` +
          `(fastagent attach, or its /control/invoke), give this run its own state (FASTAGENT_STATE_DIR=… or ` +
          `--sessions-dir), or stop the other process.`,
      );
    }
    taken.push(target);
    held.add(target);
  }
  releaseOnExit();
  return release;
}
