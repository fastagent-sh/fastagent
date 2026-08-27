/**
 * Session persistence for the `AgentSession` L0 — open-or-create a durable record by the Caller's
 * opaque session id, on pi-coding-agent's `SessionManager` (the v3 jsonl every pi surface reads).
 *
 * Records written before this store existed (by the pi-agent-core `Session` the serving path used
 * to run on) are the same v3 jsonl and are continued in place — see `legacySessionId`. That is a
 * READ path for existing conversations, not a second engine.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";
import type { SessionSummary } from "../../session.ts";
import {
  type SessionInheritance,
  stampProvenance,
  copyBranchForInheritance,
  copyBranchInto,
  inheritanceCut,
} from "./session-inheritance.ts";

/** What the AgentSession L0 needs from a session backend: open-or-create by opaque id, plus the one
 *  creation option — where a NEW session starts from (session-inheritance.ts). The three lifecycle
 *  primitives below it are the control plane's (design §12): each is a whole-RECORD operation, which
 *  is why they live here rather than growing the interactive session API. */
export interface PiSessionRecordStore {
  openOrCreate(sessionId: string, inherit?: SessionInheritance): Promise<SessionManager>;
  /** OPEN-EXISTING sibling: an unknown session answers undefined, never creates one — sessions are
   *  the data plane's monopoly. This is what the control plane reads and writes boundary records
   *  through, so a mutation on an unknown id is rejected rather than minted into a ghost record. */
  openIfExists(sessionId: string): Promise<SessionManager | undefined>;
  /** Every record this store holds, in CALLER ids. Rejects when the store cannot be enumerated —
   *  `[]` means "no sessions", so it must not double as "could not look". Answers the CONTRACT's row
   *  type: the hub forwards it, and a second identical shape here would only be a thing to keep in
   *  sync. */
  list(): Promise<SessionSummary[]>;
  /** Copy `from`'s history up to entry `at` into a new record named `into`, stamped with `provenance`
   *  so a repeat of the SAME fork can be recognised as one ({@link forkProvenance}) instead of
   *  becoming a second record or an overwrite. Throws on any failure: a half-copied fork is never
   *  left in place, and the caller turns the throw into a coded result. */
  fork(from: string, at: string, into: string, provenance: string): Promise<void>;
  /** Destroy a record. `false` = there was none (the caller answers `no_such_session`). */
  delete(sessionId: string): Promise<boolean>;
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
 * Injective within this encoding — which is only sufficient because new records live in their own
 * directory. The older spelling draws names from the same character set (it stored a room literally
 * called `s42` as `s42`, which is also this encoding of `42`), so one directory would make some
 * names ambiguous no matter how either side spells them.
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
 * {@link piSessionId} backwards — what `list()` needs, because a session id belongs to the CALLER and
 * a record name is storage detail. The encoding is self-describing (fixed widths, `_` escapes
 * itself), so this is a decode rather than a guess; a name this store did not write (no `s` head, a
 * truncated escape) answers undefined and is left out of the listing rather than reported under a
 * name nobody can dial.
 */
export function callerSessionId(recordId: string): string | undefined {
  if (!recordId.startsWith("s")) return undefined;
  let out = "";
  for (let i = 1; i < recordId.length; i++) {
    const c = recordId[i] as string;
    if (c !== "_") {
      out += c;
      continue;
    }
    const wide = recordId[i + 1] === "u";
    const start = i + (wide ? 2 : 1);
    const width = wide ? 4 : 2;
    const hex = recordId.slice(start, start + width);
    if (hex.length !== width || !/^[0-9A-F]+$/.test(hex)) return undefined;
    out += String.fromCharCode(Number.parseInt(hex, 16));
    i = start + width - 1;
  }
  return out;
}

/**
 * Disk-backed store under `dir`: restart the process, conversations continue.
 *
 * Lookup is a directory scan (`SessionManager.list`) because pi names files `<timestamp>_<id>.jsonl`
 * and the timestamp is not ours to predict — the same trade sessions.ts makes today.
 *
 * A record written before this store existed keeps ITS id (the older path spelled them differently),
 * so the scan accepts either: a conversation that predates this store is continued rather than
 * silently restarted as an empty one. Nothing is rewritten on disk.
 *
 * NEW records live in a subdirectory of their own, because the two engines cannot share a namespace:
 * both spell ids into `[A-Za-z0-9._-]`, so neither can claim a prefix the other cannot produce, and
 * a directory holding both would have names that belong to two conversations at once — in whichever
 * direction it is read. Separate directories make each side's own injectivity sufficient.
 *
 * A PRE-EXISTING record is still continued in place: it is looked up by the older spelling, which is
 * injective on its own terms, and appended to where it lies. Both spellings are the same v3 jsonl,
 * so a conversation started before this store keeps going rather than restarting empty.
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
  // Resolved against the workspace this store serves, not against wherever the process happens to
  // have been started: a relative `dir` means "inside this agent", and a serving process may chdir.
  const root = resolve(cwd, options.dir);
  const own = join(root, OWN_RECORDS_DIR);
  /** Where a forked record is finished before it becomes discoverable. A SUBDIRECTORY of the store,
   *  so `list()` (one level, `*.jsonl`) never sees a record that is still being prepared. */
  const staging = join(own, ".staging");
  /** An empty record under `id`, ON DISK (see {@link publish}) and not yet discoverable. Copying
   *  into it appends immediately, so a crash leaves a partial record in staging rather than a
   *  complete-looking one under the id. */
  const stage = (id: string): SessionManager => {
    mkdirSync(staging, { recursive: true });
    return publish(SessionManager.create(cwd, staging, { id }), staging);
  };
  /** Fill a staged record and move it in — or leave nothing behind. The partial file is deleted on
   *  the way out and the failure is rethrown untouched: `fork` turns it into a coded result and
   *  inheritance falls back to an empty session, but neither can see `.staging`, which would
   *  otherwise accumulate a file per failed attempt (ENOSPC being the realistic repeat offender) in
   *  a directory nothing ever reads. */
  const fillStaged = (id: string, fill: (staged: SessionManager) => void): SessionManager => {
    const staged = stage(id);
    try {
      fill(staged);
      // INSIDE the try: publishing is a mkdir + rename, and both can fail (EACCES, a store root on
      // another filesystem). A finished record stranded in staging is the same accumulation as a
      // partial one — nothing reads that directory either way. NOT covered by a test: the tests
      // reach the fill failure by making a copy throw, and no equivalent injection point exists for
      // rename without mocking node:fs for the whole file.
      return publishStaged(staged);
    } catch (error) {
      rmSync(staged.getSessionFile() ?? "", { force: true });
      throw error;
    }
  };
  /** Move a finished record into the store: one same-filesystem rename, so a reader sees the whole
   *  thing or nothing at all. */
  const publishStaged = (staged: SessionManager): SessionManager => {
    const file = staged.getSessionFile();
    if (!file) throw new Error(`staged record ${staged.getSessionId()} has no file to publish`);
    mkdirSync(own, { recursive: true });
    const target = join(own, basename(file));
    renameSync(file, target);
    return SessionManager.open(target, own);
  };
  /** Fork the named parent into `id`, or answer undefined so the caller starts empty. Every failure
   *  is a warn: a thread must not lose its first turn to an inheritance edge. */
  const inheritInto = async (id: string, inherit: SessionInheritance): Promise<SessionManager | undefined> => {
    const parentId = piSessionId(inherit.parentSession);
    const found =
      (await SessionManager.list(cwd, own)).find((r) => r.id === parentId) ??
      (await SessionManager.list(cwd, root)).find((r) => r.id === legacySessionId(inherit.parentSession));
    if (!found) {
      log.warn(
        `[fastagent] session "${id}" names parent "${inherit.parentSession}", which has no record — starting empty`,
      );
      return undefined;
    }
    try {
      const parentDir = found.id === parentId ? own : root;
      // A parent that crashed mid tool-execution would otherwise pass its dangling tool_use down
      // to the child, whose very first request the provider then rejects.
      const parent = reconcileInterruptedToolCalls(SessionManager.open(found.path, parentDir));
      const cut = inheritanceCut(parent, inherit.branchHints);
      if (!cut) return undefined;
      return fillStaged(id, (staged) => copyBranchForInheritance(parent, staged, cut.at));
    } catch (error) {
      // Unattributed on purpose: this spans reading the parent AND writing the child.
      log.warn(
        `[fastagent] could not inherit from "${inherit.parentSession}" into "${id}" (${String(error)}) — starting empty`,
      );
      return undefined;
    }
  };
  /** The last built listing, keyed by what every record's file looked like when it was built. */
  let listed: { stamp: string; rows: SessionSummary[] } | undefined;
  /** Open an existing record, or undefined. A closure rather than a method call, so `fork` cannot be
   *  broken by a caller that spreads this object into another one. */
  const openExisting = async (sessionId: string): Promise<SessionManager | undefined> => {
    const id = piSessionId(sessionId);
    const mine = (await SessionManager.list(cwd, own)).find((r) => r.id === id);
    if (mine) return SessionManager.open(mine.path, own);
    const legacy = (await SessionManager.list(cwd, root)).find((r) => r.id === legacySessionId(sessionId));
    return legacy ? SessionManager.open(legacy.path, root) : undefined;
  };
  return {
    async openOrCreate(sessionId, inherit) {
      const id = piSessionId(sessionId);
      const mine = (await SessionManager.list(cwd, own)).find((r) => r.id === id);
      if (mine) return reconcileInterruptedToolCalls(SessionManager.open(mine.path, own));
      const legacy = (await SessionManager.list(cwd, root)).find((r) => r.id === legacySessionId(sessionId));
      if (legacy) return reconcileInterruptedToolCalls(SessionManager.open(legacy.path, root));
      mkdirSync(own, { recursive: true });
      // Inheritance is a CREATE-path decision: an existing session above ignores it entirely, which
      // is what makes it one-time by construction.
      if (inherit) {
        const inherited = await inheritInto(id, inherit);
        if (inherited) return inherited;
      }
      return publish(SessionManager.create(cwd, own, { id }), own);
    },
    openIfExists: openExisting,
    async list() {
      // THE PROBE, not a formality: pi's own list() catches every IO error and answers `[]`, so a
      // permissions/hardware fault would arrive as "this deployment has no conversations" — the one
      // conflation `sessions_unavailable` exists to prevent, and the reason that code cannot be left
      // to pi's return value. An ABSENT directory is not a fault: no records is exactly `[]`.
      const files = existsSync(own) ? readdirSync(own).filter((f) => f.endsWith(".jsonl")) : [];
      // A conversation list is POLLED, and building one costs a full parse of every record's jsonl
      // (pi reads each line and accumulates a search index we never ask for). The cheap question is
      // whether anything changed at all: one stat per file, and an idle deployment — which is what a
      // GUI refreshing on a timer mostly finds — answers from the last build. Any single change
      // rebuilds everything, because pi's listing has no per-file entry point: the fix is for the
      // idle case, and the busy case pays what it always did.
      const stamp = files
        .map((f) => {
          const st = statSync(join(own, f));
          return `${f}:${st.mtimeMs}:${st.size}`;
        })
        .sort()
        .join("|");
      // A COPY: the cache outlives the call, and a caller that sorts the list it was handed must not
      // reorder what the next caller sees.
      if (listed && listed.stamp === stamp) return [...listed.rows];
      // THIS store's records only. A pre-existing record (the older spelling, in `root`) is still
      // opened by id and continued — but that spelling cannot be decoded back to the Caller's id,
      // and listing a row nobody can dial is worse than a row that is missing.
      const records = await SessionManager.list(cwd, own);
      const rows = records.flatMap((r) => {
        const session = callerSessionId(r.id);
        if (!session) return [];
        return [
          {
            session,
            ...(r.name ? { name: r.name } : {}),
            createdAt: r.created.getTime(),
            // NEVER before `createdAt`. pi derives "modified" from the last entry's own timestamp,
            // and a fork's entries carry the SOURCE conversation's — rewriting them would falsify
            // history, so a fresh branch would otherwise sort into last week. The record's own
            // creation is the floor: nothing about it is older than itself.
            updatedAt: Math.max(r.modified.getTime(), r.created.getTime()),
            messageCount: r.messageCount,
            // pi fills `firstMessage` with a literal "(no messages)" placeholder rather than an
            // empty string, and it does so for any session whose first user message has no
            // extractable TEXT — a caption-less photo opens plenty of them. The count cannot say
            // that (it counts every message, this one included), so the sentinel is what to exclude:
            // a client must not render pi's placeholder as if a user had typed it.
            // Sliced by CODE POINT: a cut through a surrogate pair (an emoji at the boundary) would
            // put a lone half in the row, which renders as U+FFFD.
            ...(r.firstMessage && r.firstMessage !== PI_NO_MESSAGES
              ? { preview: [...r.firstMessage].slice(0, PREVIEW_CHARS).join("") }
              : {}),
          },
        ];
      });
      listed = { stamp, rows };
      return [...rows];
    },
    async fork(from, at, into, provenance) {
      const parent = await openExisting(from);
      if (!parent) throw new Error(`session "${from}" has no record`);
      // The port promises a NEW record, so the guarantee belongs here rather than in the one caller
      // that happens to check: two records under one id makes which one a lookup finds a matter of
      // directory order.
      if (await openExisting(into)) throw new Error(`session "${into}" already exists`);
      fillStaged(piSessionId(into), (staged) => {
        // NOT reconciled: the repair appends at the parent's LEAF, which a copy stopping at `at` can
        // never reach — it would only write to the record being copied FROM. The child is reconciled
        // on its own first open, like every other record.
        copyBranchInto(parent, staged, at);
        // The name travels: a fork of "Deploy notes" that lists as untitled is a row a user cannot
        // place. A client that wants "(copy)" calls `set_name`.
        const name = parent.getSessionName();
        if (name) staged.appendSessionInfo(name);
        stampProvenance(staged, provenance);
      });
    },
    async delete(sessionId) {
      const id = piSessionId(sessionId);
      const mine = (await SessionManager.list(cwd, own)).find((r) => r.id === id);
      const legacy = mine
        ? undefined
        : (await SessionManager.list(cwd, root)).find((r) => r.id === legacySessionId(sessionId));
      const found = mine ?? legacy;
      if (!found) return false;
      // A record that cannot be deleted must not report success — the caller turns the throw into a
      // coded failure, and the session is still there for the next attempt.
      rmSync(found.path);
      return true;
    },
  };
}

/** How much of the first message a list row carries. A row, not a transcript. */
const PREVIEW_CHARS = 200;

/** pi's placeholder for "no first user message text" — a sentinel STRING, not an empty one, so it
 *  has to be excluded by value (`session-manager.js`: `firstMessage || "(no messages)"`). */
const PI_NO_MESSAGES = "(no messages)";

/**
 * Crash-safety reconciliation, run on every OPEN of an existing record.
 *
 * A turn that dies mid tool-execution leaves an assistant `tool_use` with no matching result (the
 * assistant message is persisted before the tool runs). The next turn would then hand the provider
 * an `assistant(tool_use) -> user` sequence that Anthropic and OpenAI reject — the session is
 * poisoned. An honest "interrupted" error result is appended for each dangling call, restoring a
 * valid transcript. Tool side-effect idempotency stays the tool's responsibility (SPEC §6); this
 * restores transcript validity, not exactly-once execution.
 *
 * Pairing is TURN-LOCAL: a tool_use is paired only by a toolResult that immediately follows it (up
 * to the next non-toolResult). Tool-call ids are not unique across turns — a local model may restart
 * them each response — so matching against the whole transcript could falsely settle a leaf call
 * against an earlier turn's identical id. An append-only log can only repair a gap AT THE LEAF; an
 * earlier one is surfaced via log.warn rather than "fixed" with an orphaned result.
 *
 * The synthetic result splits its audiences: `content` (read by the model, may reach the end user)
 * stays neutral — it must NOT say "aborted" (pi's word for a user cancellation) or leak infra
 * detail; `details` carries the operational marker for developers and never reaches the provider.
 */
function reconcileInterruptedToolCalls(record: SessionManager): SessionManager {
  const messages = record.getBranch().flatMap((entry) => {
    const message = (entry as { type?: string; message?: AgentMessage }).message;
    return (entry as { type?: string }).type === "message" && message ? [message] : [];
  });

  let leafIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      leafIdx = i;
      break;
    }
  }
  if (leafIdx === -1) return record; // no assistant turn yet
  const leafReparable = messages.slice(leafIdx + 1).every((m) => m.role === "toolResult");

  const toRepair: { id: string; name: string }[] = [];
  const orphaned: string[] = [];
  messages.forEach((m, idx) => {
    if (m.role !== "assistant") return;
    const paired = new Set<string>();
    for (let j = idx + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next?.role !== "toolResult") break;
      paired.add(next.toolCallId);
    }
    for (const block of m.content) {
      if (block.type !== "toolCall" || paired.has(block.id)) continue;
      if (idx === leafIdx && leafReparable) toRepair.push({ id: block.id, name: block.name });
      else orphaned.push(block.id);
    }
  });

  if (orphaned.length > 0) {
    log.warn(
      `[fastagent] unmatched tool_use is not at the session leaf; leaving it unreconciled ` +
        `(an append-only log cannot repair a mid-history gap): toolCallIds=${orphaned.join(",")}`,
    );
  }

  for (const { id, name } of toRepair) {
    record.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [
        {
          type: "text",
          text: "This tool call did not complete and its result is unavailable. Re-run it if the result is still needed.",
        },
      ],
      details: { fastagent: "interrupted-tool-call" },
      isError: true,
      timestamp: Date.now(),
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  }
  return record;
}

/** Where this engine's own records live, under the sessions directory both engines are pointed at. */
const OWN_RECORDS_DIR = "agent-session";

/**
 * Make a NEW record exist on disk before anyone can act on it.
 *
 * `SessionManager` buffers a new session in memory and writes nothing until the first ASSISTANT
 * message arrives (`_persist` returns early while no assistant entry exists). Two consequences, and
 * the second is why this cannot be left to the engine:
 *
 * - a crash between "the user asked" and "the model answered" loses the question, while the record
 *   pi-agent-core's storage wrote it immediately (conformance-levels.md §5 named this gap);
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
    async openOrCreate(sessionId, inherit) {
      // Keyed by the CALLER's id: the encoding exists to satisfy pi's filename rule, and in memory
      // there are no filenames — two rooms whose encodings collide must still not share a map slot.
      const existing = live.get(sessionId);
      if (existing) return reconcileInterruptedToolCalls(existing);
      const fresh = () => SessionManager.inMemory(cwd, { id: piSessionId(sessionId) });
      // Same semantics as the durable store, different mechanism: with no file to fork, the parent's
      // path is copied entry by entry. Inheritance is a property of the CONTRACT, not of the medium —
      // a caller must not get a thread that forgot its room because the store is in memory.
      //
      // And the same atomicity: the session is REGISTERED only once it is complete. Registering
      // first and copying after would leave a half-inherited thread in place on any failure, while
      // the log claimed it started empty — the disk path stages a fork for exactly this reason.
      const parent = inherit ? live.get(inherit.parentSession) : undefined;
      if (inherit && !parent) {
        log.warn(
          `[fastagent] session "${sessionId}" names parent "${inherit.parentSession}", which has no record — starting empty`,
        );
      }
      let created: SessionManager;
      if (inherit && parent) {
        try {
          const staged = fresh();
          const cut = inheritanceCut(reconcileInterruptedToolCalls(parent), inherit.branchHints);
          if (cut) copyBranchForInheritance(parent, staged, cut.at);
          created = staged;
        } catch (error) {
          log.warn(
            `[fastagent] could not inherit from "${inherit.parentSession}" into "${sessionId}" (${String(error)}) — starting empty`,
          );
          created = fresh(); // the partially-copied one is discarded, never registered
        }
      } else {
        created = fresh();
      }
      live.set(sessionId, created);
      return created;
    },
    async openIfExists(sessionId) {
      return live.get(sessionId);
    },
    async list() {
      // No file metadata in memory: the timestamps that exist are the entries' own. A session with
      // no entries yet reports the same instant for both, which is what "created, never used" is.
      // No `preview`: the field is optional by contract, and digging a first user message out of
      // pi's entry union would be more code here than the row is worth. The disk store, which is
      // what a deployment lists, gets it from pi's own index for free.
      return [...live].map(([session, record]) => {
        const entries = record.getEntries() as { timestamp?: string; type?: string }[];
        const times = entries.flatMap((e) => (e.timestamp ? [Date.parse(e.timestamp)] : []));
        const name = record.getSessionName();
        return {
          session,
          ...(name ? { name } : {}),
          createdAt: times[0] ?? 0,
          updatedAt: times[times.length - 1] ?? 0,
          messageCount: entries.filter((e) => e.type === "message").length,
        };
      });
    },
    async fork(from, at, into, provenance) {
      const parent = live.get(from);
      if (!parent) throw new Error(`session "${from}" has no record`);
      // The port's promise, not the caller's: registering over a live session would replace its
      // history outright.
      if (live.has(into)) throw new Error(`session "${into}" already exists`);
      // Entry-by-entry, like the in-memory inheritance path: there is no file to fork. Registered
      // only once complete, so a failure leaves no half-copied session behind. NO inheritance
      // window: this is the same user keeping their own history, not a new thread bounded from a
      // parent's.
      const staged = SessionManager.inMemory(cwd, { id: piSessionId(into) });
      copyBranchInto(parent, staged, at);
      // The name travels, because on disk it cannot NOT travel: pi copies the whole path, and the
      // `session_info` record sits on it. One behaviour for both backends beats a truthful-sounding
      // difference nobody can predict — a client that wants "(copy)" calls `set_name`.
      const name = parent.getSessionName();
      if (name) staged.appendSessionInfo(name);
      stampProvenance(staged, provenance);
      live.set(into, staged);
    },
    async delete(sessionId) {
      return live.delete(sessionId);
    },
  };
}

/** The spelling used before this store existed — read-only, so older records still resolve. */
function legacySessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x100
      ? `%${code.toString(16).toUpperCase().padStart(2, "0")}`
      : `%u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  });
}
