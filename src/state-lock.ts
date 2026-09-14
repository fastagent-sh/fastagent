/**
 * THE refusal: file-backed agent state has ONE writer.
 *
 * The session store is an append-structured journal and the channel/schedule files are whole-file rewrites, so two
 * processes over one directory interleave entries and lose each other's updates. Nothing else coordinates that — the
 * per-invoke session lease is an in-memory Set, which a second process does not share — so the ordinary way into the
 * unsupported topology is two ordinary commands (`dev` serving while `fire` runs the same `schedule:<name>`
 * conversation, two `start`s on different ports over one directory).
 *
 * The claim is a LISTENING SOCKET, not a lock file, because that makes the two questions this guard kept getting
 * wrong into facts the kernel answers:
 *
 *   - *Is the holder still alive?* A dead holder's socket refuses connections the instant its process ends
 *     (verified: SIGKILL → `ECONNREFUSED`), so there is no stale window to wait out, no heartbeat to keep, and no
 *     asking the OS whether a pid from a file is running — which a container, where the agent is pid 1, answers
 *     wrongly about itself.
 *   - *Who holds it?* The holder answers with its own pid and command line. A refusal states that rather than
 *     inferring it.
 *
 * The socket lives in `/tmp` under a hash of the guarded directory, not inside it, for two reasons: a unix socket
 * path is capped at ~104 bytes (an ordinary nested project blows that), and the agent's state directory stays free
 * of a file nobody should have to reason about.
 *
 * The exclusion is therefore per KERNEL NAMESPACE — the machine, or the container. That is the tier this guard
 * enforces (docs/deploy.md, "Single-machine tier"); one process per mounted volume is a different question, already
 * answered by `leaseDeployment`, and several replicas need shared session/lease/channel-state backends rather than
 * any file lock.
 */
import { existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { type Server, connect, createServer } from "node:net";
import { resolve } from "node:path";

/**
 * Short, machine-global, collision-free: the guarded directory is the identity, its hash is the name. `/tmp` rather
 * than `os.tmpdir()` because macOS makes the latter per-user, and two users writing one directory must still
 * contend (the loser gets a refusal, never a silent share: a sticky `/tmp` refuses to let it delete a stale socket
 * that is not its own, and that error surfaces). The deployed image already writes there (`npm_config_cache`).
 */
function socketFor(dir: string): string {
  const digest = createHash("sha256").update(dir).digest("hex").slice(0, 16);
  return `/tmp/fastagent-${digest}.sock`;
}

/** How long to wait for an answer before treating the holder as unreachable rather than hanging a boot. */
const PROBE_TIMEOUT_MS = 2_000;

/** What a holder says about itself. */
interface Holder {
  pid: number;
  command: string;
  /** Distinguishes OUR server from one that replaced it while two processes raced to take over a dead claim. */
  nonce: string;
}

function describe(holder: Holder): string {
  return `pid ${holder.pid}${holder.command ? ` (${holder.command})` : ""}`;
}

/** Ask who is listening. `undefined` = nobody: either no socket at all, or one its process did not outlive. */
function probe(path: string): Promise<Holder | undefined> {
  return new Promise((resolve_) => {
    const socket = connect(path);
    let answer = "";
    const done = (holder: Holder | undefined): void => {
      socket.destroy();
      resolve_(holder);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(undefined));
    socket.on("data", (chunk) => {
      answer += chunk;
    });
    socket.on("end", () => {
      try {
        done(JSON.parse(answer) as Holder);
      } catch {
        // Something else owns this path (a stray socket): not a claim of ours, and not ours to delete.
        done(undefined);
      }
    });
    // ECONNREFUSED/ENOENT: the file outlived its process, or was never there.
    socket.on("error", () => done(undefined));
  });
}

function listenOn(path: string, answer: string): Promise<Server> {
  return new Promise((resolve_, reject) => {
    const server = createServer((connection) => connection.end(answer));
    server.once("error", reject);
    server.listen(path, () => {
      // The claim must not be what keeps a one-shot command running: `invoke` exits when its turn is done.
      server.unref();
      resolve_(server);
    });
  });
}

function refuse(dir: string, holder: Holder): Error {
  return new Error(
    holder.pid === process.pid
      ? `this process already opened this agent's state — one writer per directory, in this process too ` +
          `(${dir}). Close the first agent (AgentService.close(), or the opener's dispose()) before opening it ` +
          `again, or give the second one its own state (FASTAGENT_STATE_DIR / sessionsDir).`
      : `another process is already writing this agent's state — ${describe(holder)} — and file-backed state has ` +
          `one writer: a second one interleaves session journals and drops channel state (${dir}). Stop that ` +
          `process, give this run its own state (FASTAGENT_STATE_DIR=… or --sessions-dir), or ask the running ` +
          `service instead — its POST /invoke on the port it printed, or /control/* with sessionControl: true.`,
  );
}

/** One directory. Returns the server holding it, or throws the refusal naming who does. */
async function take(dir: string): Promise<Server> {
  const path = socketFor(dir);
  const nonce = crypto.randomUUID();
  const answer = `${JSON.stringify({ pid: process.pid, command: process.argv.slice(1).join(" ").slice(0, 120), nonce } satisfies Holder)}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let server: Server;
    try {
      server = await listenOn(path, answer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      const holder = await probe(path);
      if (holder) throw refuse(dir, holder);
      // Nobody is listening: the file outlived its process. Removing it is the takeover, and the verification
      // below is what makes losing the race to another taker visible instead of silent.
      if (existsSync(path)) unlinkSync(path);
      continue;
    }
    const owner = await probe(path);
    if (owner?.nonce === nonce) return server;
    server.close();
    // Another process unlinked our socket and listened on the path between the two calls above. Ours is now bound
    // to an inode nothing can reach, so it is not a claim.
    if (owner) throw refuse(dir, owner);
  }
  throw new Error(`could not take the write claim for ${dir} — it kept changing hands`);
}

/**
 * Take write ownership of every given directory, or refuse with who holds it and the way out.
 *
 * The returned release is the whole lifetime: a caller that outlives its agent calls it, and a process that exits or
 * dies drops the claim with its socket.
 */
export async function lockAgentState(dirs: readonly string[]): Promise<() => Promise<void>> {
  const held: Server[] = [];
  const release = async (): Promise<void> => {
    // Node unlinks the socket file on close (verified), so a released claim leaves nothing behind to reason about.
    await Promise.all(held.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  };
  try {
    for (const dir of new Set(dirs.map((dir) => resolve(dir)))) held.push(await take(dir));
  } catch (error) {
    // A second directory that cannot be claimed must not leave the first one held: the caller gets the error and no
    // release handle, so nothing else could give it back.
    await release();
    throw error;
  }
  return release;
}
