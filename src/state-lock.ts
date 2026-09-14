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
 * `dev`'s supervisor already respawns only after its worker exited, so this stays ~1s rather than making a genuine
 * second writer look like a hang to someone waiting on a one-shot command.
 */
const RETRIES = { retries: 3, factor: 3, minTimeout: 100, maxTimeout: 600, randomize: true };

/**
 * What a RESIDENT server waits instead (~23s, past {@link STALE_MS}). Its predecessor may have been killed without
 * releasing — a container OOM, a platform migration, an AgentCore runtime whose storage outlives its compute — and
 * refusing to boot for the seconds until that claim expires costs more than waiting: on AgentCore the refusal is
 * cached by `deferAgentcoreService` and turns the whole runtime session into 503s.
 */
const RESIDENT_RETRIES = { retries: 8, factor: 2, minTimeout: 250, maxTimeout: 5_000, randomize: true };

/** The targets THIS process holds — the only way to tell its own claim from an identical pid it inherited. */
const mine = new Set<string>();

/**
 * Who holds the lock, and whether they are still running. The holder writes its pid into the lock target, so the
 * refusal can name a process; `kill(pid, 0)` then separates the two cases that need different advice — a live
 * second writer (stop it) from a claim a killed holder left behind (wait out {@link STALE_MS}).
 *
 * Three answers, because they need three different remedies: THIS process already opened the directory (close the
 * first agent), another process is writing (stop it), or a claim is leftover (wait out {@link STALE_MS}).
 *
 * The pid alone cannot tell the first from the third IN A CONTAINER: the image runs the agent as pid 1, so a
 * restarted container reads its predecessor's `1` and asks whether pid 1 is alive — it is, and it is this very
 * process. What separates them is {@link mine}: a claim we took is ours, and a pid equal to ours that we did not
 * take is leftover. A recycled pid from another process still reads as alive, which is the current wording rather
 * than a worse one.
 */
function holderOf(target: string): { label: string; kind: "self" | "alive" | "gone" } {
  if (mine.has(target)) return { label: ` (pid ${process.pid}, this process)`, kind: "self" };
  let pid = 0;
  try {
    const raw = readFileSync(target, "utf8").trim();
    if (/^\d+$/.test(raw)) pid = Number(raw);
  } catch {
    // The holder released between the failed acquire and this read, or the file is unreadable — the refusal still
    // names the path, which is the part that always exists.
  }
  if (pid === 0) return { label: "", kind: "alive" };
  // Our own pid that we did NOT take: the container case above.
  if (pid === process.pid) return { label: ` (pid ${pid})`, kind: "gone" };
  try {
    process.kill(pid, 0); // signal 0: ask whether the process exists, send nothing
    return { label: ` (pid ${pid})`, kind: "alive" };
  } catch (error) {
    // EPERM = alive but owned by another user. Only ESRCH proves it is gone.
    return { label: ` (pid ${pid})`, kind: (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "alive" };
  }
}

/**
 * Take write ownership of every given directory, or refuse with who holds it and the ways out.
 *
 * `resident` is the posture, not a preference: a server that is booting waits out a predecessor's expiring claim
 * ({@link RESIDENT_RETRIES}), while a one-shot command refuses quickly rather than hanging on a live writer.
 *
 * The returned release is for a caller that outlives its agent (an embedder unmounting a service, a test); a CLI
 * command just exits.
 */
export async function lockAgentState(
  dirs: readonly string[],
  options: { resident?: boolean } = {},
): Promise<() => Promise<void>> {
  const targets = [...new Set(dirs.map((dir) => join(resolve(dir), LOCK_FILE)))];
  const taken: string[] = [];
  const release = async (): Promise<void> => {
    for (const target of taken.splice(0)) {
      mine.delete(target);
      await lockfile.unlock(target, { realpath: false }).catch((error: unknown) => {
        // ENOTACQUIRED = the lock was already compromised and dropped (a module-level `unlock` of a lock
        // proper-lockfile no longer tracks), which onCompromised reported at the moment it mattered. Repeating it
        // here would put an unrelated warning on every clean shutdown after one.
        if ((error as NodeJS.ErrnoException).code === "ENOTACQUIRED") return;
        log.warn(`[fastagent] could not release the state lock ${target}: ${String(error)}`);
      });
    }
  };
  try {
    for (const target of targets) await take(target, options.resident === true, taken);
  } catch (error) {
    // Everything in `take` is a side effect on the way to ownership: a second directory that cannot be prepared, a
    // pid that cannot be written. Whatever was already locked goes back — otherwise the caller gets an exception
    // and no release handle, and the claim waits for process exit.
    await release();
    throw error;
  }
  return release;
}

/** One directory: prepare the target, take the lock, then record ownership and stamp the pid. */
async function take(target: string, resident: boolean, taken: string[]): Promise<void> {
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, "", { flag: "a" }); // proper-lockfile locks an EXISTING path
  try {
    await lockfile.lock(target, {
      realpath: false,
      stale: STALE_MS,
      retries: resident ? RESIDENT_RETRIES : RETRIES,
      // The lock directory vanished under us (someone cleared the state root). Default behaviour rethrows from a
      // timer, which takes the process down over a guard; the ownership is genuinely lost either way, so say so
      // and keep serving — the work in flight is what the guard exists to protect. ERROR level, because the
      // invariant this module exists for is gone from here on.
      onCompromised: (error) =>
        log.error(`[fastagent] the state lock ${target} was lost — another process could now write: ${String(error)}`),
    });
  } catch (error) {
    // Only the wording is this catch's business; the caller's `release()` covers what was already taken.
    if ((error as { code?: string }).code !== "ELOCKED") throw error;
    const holder = holderOf(target);
    throw new Error(
      holder.kind === "self"
        ? `this process already opened this agent's state${holder.label} — one writer per directory, in this ` +
            `process too (${target}). Close the first agent (AgentService.close(), or the opener's releaseState()) ` +
            `before opening it again, or give the second one its own state (FASTAGENT_STATE_DIR / sessionsDir).`
        : holder.kind === "alive"
          ? `another process is already writing this agent's state${holder.label} — file-backed state has one ` +
            `writer, and a second one interleaves session journals and drops channel state (${target}). Stop that ` +
            `process, give this run its own state (FASTAGENT_STATE_DIR=… or --sessions-dir), or ask the running ` +
            `service instead — its POST /invoke on the port it printed, or /control/* with sessionControl: true.`
          : `this agent's state is claimed by a process that is gone${holder.label} — it was killed without ` +
            `releasing (${target}). The claim clears itself within ${STALE_MS / 1000}s: retry then, or delete ` +
            `${target}.lock if you know nothing else is writing here.`,
    );
  }
  // Recorded BEFORE the pid stamp: from here the lock is held, so a failure to write the stamp must still be a
  // release this function's caller can perform.
  taken.push(target);
  mine.add(target);
  // Written after the lock is ours, so the pid a refusal reads is the holder's and not a loser's.
  writeFileSync(target, `${process.pid}\n`);
}
