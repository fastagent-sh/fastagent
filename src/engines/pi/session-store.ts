/**
 * Session persistence for the `AgentSession` L0 — open-or-create a durable record by the Caller's
 * opaque session id, on pi-coding-agent's `SessionManager` (the v3 jsonl every pi surface reads).
 *
 * The harness path's sibling is sessions.ts, which speaks pi-agent-core's `Session` instead. Both
 * write the same file format; they differ in which pi class reads it. That one retires with the
 * harness L0.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** What the AgentSession L0 needs from a session backend: open-or-create by opaque id. */
export interface PiSessionRecordStore {
  openOrCreate(sessionId: string): Promise<SessionManager>;
}

/**
 * A Caller's session id, as a name pi will accept.
 *
 * `SessionManager` enforces `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$` — which no built-in
 * channel satisfies: telegram's `-1001234567890` leads with a dash, feishu and slack keys carry
 * `:` and `/`, and any custom `route()` may mint anything at all.
 *
 * The mapping is INJECTIVE, because two conversations resolving to one record is two rooms sharing a
 * memory. `s` prefix (the pattern demands an alphanumeric head, and prefixing unconditionally is what
 * keeps it injective — a conditional one would map `-a` and `s-a` alike), then each character
 * outside `[A-Za-z0-9.-]` becomes `_XX` / `_uXXXX`, self-describing widths so no two inputs can
 * produce one output. `_` escapes itself for the same reason. A trailing `.` or `-` is legal
 * mid-name but not at the end, so it escapes too.
 *
 * Readability is deliberate: `-1001234567890` becomes `s-1001234567890`, so an operator can still
 * tell which room a file belongs to.
 */
export function piSessionId(sessionId: string): string {
  const hex = (c: string): string => {
    const code = c.charCodeAt(0);
    return code < 0x100
      ? `_${code.toString(16).toUpperCase().padStart(2, "0")}`
      : `_u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  };
  const body = sessionId.replace(/[^A-Za-z0-9.-]/g, hex).replace(/[.-]$/, hex);
  return `s${body}`;
}

/**
 * Disk-backed store under `dir`: restart the process, conversations continue.
 *
 * Lookup is a directory scan (`SessionManager.list`) because pi names files `<timestamp>_<id>.jsonl`
 * and the timestamp is not ours to predict — the same trade sessions.ts makes today.
 *
 * A record written by the harness path keeps ITS id (sessions.ts encodes differently), so the scan
 * accepts either spelling: a conversation that predates this store is found and continued rather
 * than silently restarted as an empty one. Nothing is rewritten on disk.
 */
export function piSessionRecordStore(options: { dir: string; cwd?: string }): PiSessionRecordStore {
  const cwd = options.cwd ?? process.cwd();
  return {
    async openOrCreate(sessionId) {
      const id = piSessionId(sessionId);
      const records = await SessionManager.list(cwd, options.dir);
      const existing = records.find((r) => r.id === id) ?? records.find((r) => r.id === legacySessionId(sessionId));
      if (existing) return SessionManager.open(existing.path, options.dir);
      return publish(SessionManager.create(cwd, options.dir, { id }), options.dir);
    },
  };
}

/**
 * Make a NEW record exist on disk before anyone can act on it.
 *
 * `SessionManager` buffers a new session in memory and writes nothing until the first ASSISTANT
 * message arrives (`_persist` returns early while no assistant entry exists). Two consequences, and
 * the second is why this cannot be left to the engine:
 *
 * - a crash between "the user asked" and "the model answered" loses the question, while the record
 *   the harness path writes has it (conformance-levels.md §5 names this gap);
 * - **open-or-create stops being idempotent**: the second call cannot find the first call's record,
 *   so one conversation forks into two files, each with half the history.
 *
 * Writing pi's OWN header (`getHeader()`, not a hand-built literal) and reopening puts the manager
 * on its normal "file exists" path, where every append lands immediately.
 */
function publish(session: SessionManager, dir: string): SessionManager {
  const file = session.getSessionFile();
  if (!file || existsSync(file)) return session; // in-memory, or already on disk
  const header = session.getHeader();
  if (!header) return session;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
  return SessionManager.open(file, dir);
}

/** In-process store: continuity lives and dies with the instance. */
export function piInMemorySessionRecordStore(options: { cwd?: string } = {}): PiSessionRecordStore {
  const cwd = options.cwd ?? process.cwd();
  const live = new Map<string, SessionManager>();
  return {
    async openOrCreate(sessionId) {
      const id = piSessionId(sessionId);
      const existing = live.get(id);
      if (existing) return existing;
      const created = SessionManager.inMemory(cwd, { id });
      live.set(id, created);
      return created;
    },
  };
}

/** sessions.ts's spelling of the same id — read-only, so records written by the harness path resolve. */
function legacySessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x100
      ? `%${code.toString(16).toUpperCase().padStart(2, "0")}`
      : `%u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  });
}
