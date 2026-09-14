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
 *
 * Two known limits, stated rather than papered over:
 *
 *   - A claim can only be TAKEN OVER when the kernel says nobody is listening. Anything else — a holder too busy to
 *     answer, a foreign socket, a path this user may not read — refuses. Refusing a run is recoverable; deciding a
 *     live writer is dead is not.
 *   - `dev --tunnel`'s supervisor writes channel onboarding state (`src/tunnel.ts` → `writeSlackOnboardingState`)
 *     while its worker holds the claim, so that one file has two writers by design. It is written once per
 *     registration, not per turn.
 */
import { closeSync, openSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { type Server, connect, createServer } from "node:net";
import { resolve } from "node:path";

/**
 * Short, machine-global, collision-free: the guarded directory is the identity, its hash is the name. `/tmp` rather
 * than `os.tmpdir()` because macOS makes the latter per-user, and two users writing one directory must still
 * contend — one of them wins the name and the other is refused, never a silent share. The deployed image already
 * writes there (`npm_config_cache`).
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
}

function describe(holder: Holder): string {
  return `pid ${holder.pid}${holder.command ? ` (${holder.command})` : ""}`;
}

/**
 * What the path answers. `absent` is the ONLY state that permits a takeover: it is the kernel saying nothing is
 * listening. `unknown` covers a holder that did not answer in time, an answer that is not ours, and a path this
 * process may not read — none of which prove the writer is gone.
 */
type Probe = { state: "held"; holder: Holder } | { state: "absent" } | { state: "unknown"; why: string };

function probe(path: string): Promise<Probe> {
  return new Promise((resolve_) => {
    const socket = connect(path);
    let answer = "";
    const done = (result: Probe): void => {
      socket.destroy();
      resolve_(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () =>
      done({ state: "unknown", why: `it did not answer within ${PROBE_TIMEOUT_MS}ms` }),
    );
    socket.on("data", (chunk) => {
      answer += chunk;
    });
    socket.on("end", () => {
      try {
        done({ state: "held", holder: JSON.parse(answer) as Holder });
      } catch {
        done({ state: "unknown", why: "something that is not a fastagent agent is listening there" });
      }
    });
    socket.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      // Only these two are the kernel saying "no listener": the file outlived its process, or was never there.
      done(
        code === "ECONNREFUSED" || code === "ENOENT"
          ? { state: "absent" }
          : { state: "unknown", why: `connecting to it failed with ${code ?? String(error)}` },
      );
    });
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

/** The path is taken but its holder cannot be identified — refuse, because the alternative is deciding it is dead. */
function refuseUnknown(dir: string, path: string, why: string): Error {
  return new Error(
    `this agent's state (${dir}) is claimed at ${path}, but ${why} — refusing rather than assuming the writer is ` +
      `gone. Stop whatever holds it, give this run its own state (FASTAGENT_STATE_DIR=… or --sessions-dir), or ` +
      `delete ${path} if you know nothing is writing there.`,
  );
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

/**
 * Serializes the one step that is not atomic: removing a dead holder's name. `link`/`bind` refuse an existing name
 * on their own, but "unlink then bind" has a gap in which a second taker can delete the name the first just bound.
 * A stale sentinel (a crash inside that microsecond) costs a refusal that names the file to remove — the fail-safe
 * direction, unlike two writers who each believe they are alone.
 */
function withTakeoverSentinel<T>(dir: string, path: string, work: () => T): T {
  const sentinel = `${path}.takeover`;
  let fd: number;
  try {
    fd = openSync(sentinel, "wx");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw refuseUnknown(
      dir,
      path,
      code === "EEXIST"
        ? `another process is taking it over (${sentinel})`
        : `its takeover marker could not be created (${code ?? String(error)})`,
    );
  }
  try {
    return work();
  } finally {
    closeSync(fd);
    unlinkSync(sentinel);
  }
}

/** One directory. Returns the server holding it, or throws the refusal naming who does. */
async function take(dir: string): Promise<Server> {
  const path = socketFor(dir);
  const answer = `${JSON.stringify({ pid: process.pid, command: process.argv.slice(1).join(" ").slice(0, 120) } satisfies Holder)}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await listenOn(path, answer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
    const found = await probe(path);
    if (found.state === "held") throw refuse(dir, found.holder);
    if (found.state === "unknown") throw refuseUnknown(dir, path, found.why);
    // Nobody is listening: the name outlived its process. Removing it is the takeover, and only one process may be
    // inside that step — after it, the bind below is the kernel's own exclusion again.
    withTakeoverSentinel(dir, path, () => {
      try {
        unlinkSync(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return; // another taker got there first; the retry below sorts it out
        throw refuseUnknown(dir, path, `its dead claim could not be removed (${code ?? String(error)})`);
      }
    });
  }
  // The second attempt found the name taken again: someone bound it between our unlink and our bind. They are the
  // holder now, so say so rather than looping.
  const found = await probe(path);
  throw found.state === "held" ? refuse(dir, found.holder) : refuseUnknown(dir, path, "it kept changing hands");
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
