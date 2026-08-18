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
 * Injective WITHIN this encoding, which is not the same as unique on disk: the harness path spells
 * ids differently and its records share the directory, so `s42` is what this produces for `42` AND
 * what that path produces for `s42`. {@link recordOwner} is how a lookup tells them apart.
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
 *
 * SCOPE OF "open-or-create": idempotent against a store that is serialized per session, which is what
 * the serving path provides — the single-writer lease is taken before any store call, so no two
 * turns of one conversation reach this at once. What it does NOT do is arbitrate a FIRST open racing
 * across processes: two instances that scan before either writes will both create, and the
 * conversation forks into two records. sessions.ts states the same boundary for the same reason
 * ("the serving path serializes it with the single-writer lease before reaching any store"), and a
 * horizontally-scaled deployment that wants more owes a lease that spans its instances — an
 * in-process one cannot arbitrate between them, and a file lock here would only look like it could.
 */
export function piSessionRecordStore(options: { dir: string; cwd?: string }): PiSessionRecordStore {
  const cwd = options.cwd ?? process.cwd();
  return {
    async openOrCreate(sessionId) {
      const id = piSessionId(sessionId);
      const records = await SessionManager.list(cwd, options.dir);
      // A record this store wrote carries the Caller's id verbatim, so a name collision with the
      // harness path's spelling is decided by asking rather than by hoping: `42` encodes to `s42`,
      // and so does the harness path's own `s42`.
      const claimed = (name: string, accept: (owner: string | undefined) => boolean): SessionManager | undefined => {
        for (const candidate of records.filter((r) => r.id === name)) {
          const opened = SessionManager.open(candidate.path, options.dir);
          if (accept(recordOwner(opened))) return opened;
        }
        return undefined;
      };
      const ours = claimed(id, (owner) => owner === sessionId);
      if (ours) return ours;
      // Nothing of ours under our name. A record written before this store existed carries no claim
      // and is named by the harness path's own injective spelling, so an UNCLAIMED hit there is this
      // conversation — while a claimed one belongs to whichever Caller id claimed it.
      const legacy = claimed(legacySessionId(sessionId), (owner) => owner === undefined || owner === sessionId);
      if (legacy) return legacy;
      const created = publish(SessionManager.create(cwd, options.dir, { id }), options.dir);
      created.appendCustomEntry(SESSION_OWNER_ENTRY, { sessionId });
      return created;
    },
  };
}

/** Marks whose conversation a record holds — the Caller's id, not pi's spelling of it. */
const SESSION_OWNER_ENTRY = "fastagent:session-owner";

/** The Caller id a record was created for, or undefined when nothing claimed it. */
function recordOwner(session: SessionManager): string | undefined {
  for (const entry of session.getEntries()) {
    const claim = entry as { type?: string; customType?: string; data?: { sessionId?: unknown } };
    if (claim.type === "custom" && claim.customType === SESSION_OWNER_ENTRY) {
      return typeof claim.data?.sessionId === "string" ? claim.data.sessionId : undefined;
    }
  }
  return undefined;
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
      // Keyed by the CALLER's id: the encoding exists to satisfy pi's filename rule, and in memory
      // there are no filenames - two rooms whose encodings collide must still not share a map slot.
      const existing = live.get(sessionId);
      if (existing) return existing;
      const created = SessionManager.inMemory(cwd, { id: piSessionId(sessionId) });
      live.set(sessionId, created);
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
