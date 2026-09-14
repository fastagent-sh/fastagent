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
 * Releasing is `proper-lockfile`'s own: it deletes every lock it holds on process exit, including on the signals a
 * `process.on("exit")` hook never sees. A caller that outlives its agent takes the returned release.
 *
 * The deployed path has its own, coarser lease (`leaseDeployment` — one process per mounted volume, `flock`, held
 * for the process lifetime). Both can hold at once; they answer different questions.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { log } from "./log.ts";

/** The lock target inside each guarded directory (so its `.lock` sibling also lands there, not beside the agent). */
const LOCK_FILE = "writer.lock";

/**
 * How long a holder that died without releasing keeps the directory. `proper-lockfile` touches the lock while the
 * process lives, so this bounds only a kill that ran no exit handler.
 */
const STALE_MS = 15_000;

/**
 * A short retry, for the one case that is not a real conflict: a manual restart racing the outgoing process's exit.
 * `dev`'s supervisor already respawns only after its worker exited, so this stays ~1s rather than a wait that makes
 * a genuine second writer look like a hang.
 */
const RETRIES = { retries: 3, factor: 3, minTimeout: 100, maxTimeout: 600, randomize: true };

/** The holder writes its pid into the lock target, so the refusal can name a process rather than a path. */
function holderOf(target: string): string {
  try {
    const pid = readFileSync(target, "utf8").trim();
    return /^\d+$/.test(pid) ? ` (pid ${pid})` : "";
  } catch {
    // The holder released between the failed acquire and this read, or the file is unreadable — either way the
    // refusal below still names the path, which is the part that always exists.
    return "";
  }
}

/**
 * Take write ownership of every given directory, or refuse with who holds it and the ways out.
 *
 * The returned release is for a caller that outlives its agent (an embedder unmounting a service, a test); a CLI
 * command just exits.
 */
export async function lockAgentState(dirs: readonly string[]): Promise<() => Promise<void>> {
  const targets = [...new Set(dirs.map((dir) => join(resolve(dir), LOCK_FILE)))];
  const taken: string[] = [];
  const release = async (): Promise<void> => {
    for (const target of taken.splice(0)) {
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
        `another process is already writing this agent's state${holderOf(target)} — file-backed state has one ` +
          `writer, and a second one interleaves session journals and drops channel state (${target}). Stop that ` +
          `process, give this run its own state (FASTAGENT_STATE_DIR=… or --sessions-dir), or ask the running ` +
          `service instead — its POST /invoke on the port it printed, or /control/* with sessionControl: true.`,
      );
    }
    // Written after the lock is ours, so the pid a refusal reads is the holder's and not a loser's.
    writeFileSync(target, `${process.pid}\n`);
    taken.push(target);
  }
  return release;
}
