/**
 * Session persistence for the `AgentSession` L0 — open-or-create a durable record by the Caller's
 * opaque session id, on pi-coding-agent's `SessionManager` (the v3 jsonl every pi surface reads).
 *
 * Records written before this store existed (by the pi-agent-core `Session` the serving path used
 * to run on) are the same v3 jsonl and are continued in place — see `legacySessionId`. That is a
 * READ path for existing conversations, not a second engine.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";
import type { SessionSummary, SessionUpdateField } from "../../session.ts";
import { LEAF_ANCHOR, publishedLeaf, stampProvenance } from "./session-markers.ts";
import { type OverrideEntryLike, activePath } from "./session-settings.ts";
import {
  type SessionInheritance,
  copyBranchForInheritance,
  copyBranchInto,
  inheritanceCut,
} from "./session-inheritance.ts";

/**
 * The session RECORDS, as operations rather than as pi handles.
 *
 * The distinction is the point. `openOrCreate`/`openIfExists` hand out a live `SessionManager` for
 * the two things that genuinely need one — driving a turn, and reading a session's contents — and
 * everything else is a whole-record operation implemented HERE. That line was drawn after the
 * lifecycle work: when the control plane wrote properties by calling pi's append methods itself, it
 * had to know pi's rules to do it (every append advances the single leaf pointer, so order decides
 * where a fork's head lands; `appendSessionInfo` rewrites the name it is given; a record buffers in
 * memory until its first assistant message). Every caller learning those separately is how the same
 * fact ended up half-known in two modules — so they are known once, here.
 */
export interface PiSessionRecordStore {
  openOrCreate(sessionId: string, inherit?: SessionInheritance): Promise<SessionManager>;
  /** OPEN-EXISTING sibling: an unknown session answers undefined, never creates one — sessions are
   *  the data plane's monopoly. The READ path (state/entries) and the turn binding use this; the
   *  write path does not, because a caller holding a handle is a caller learning pi's rules. */
  openIfExists(sessionId: string): Promise<SessionManager | undefined>;
  /**
   * Write session properties, in the order pi's leaf pointer requires, and report what LANDED.
   *
   * Each property is its own journal entry — pi has no "append these together" — so a failure
   * partway is a real state, and this answers it rather than pretending a rollback happened. The
   * caller supplies an already-VALIDATED patch (a model resolved to provider+id, a level this model
   * accepts): what belongs here is how a record is written, not what a value means.
   *
   * `undefined` = no such record (it vanished between the caller's check and this call).
   */
  applyProperties(sessionId: string, writes: PropertyWrites): Promise<AppliedProperties | undefined>;
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

/** A validated property patch, in the shape a RECORD takes it: the model already resolved to the
 *  provider + id pi's append wants, so this layer never asks what a model spec means. */
export interface PropertyWrites {
  name?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  leafEntryId?: string;
}

/** What a property write actually did, and what the record holds after it. */
interface AppliedProperties {
  /** In write order. A field asked for but absent here did not land. */
  landed: SessionUpdateField[];
  /** Why the rest stopped, if anything did. The caller turns this into a coded result; the record
   *  already reflects `landed`. */
  failure?: unknown;
  /** The record AFTER the writes — what the caller reports, rather than echoing the request. pi
   *  rewrites a name (newlines collapse, ends trim), so the request is not what was stored. */
  name?: string;
  leafEntryId?: string;
  /** The active path after the writes, for a caller that resolves settings against a model registry
   *  this layer has no business knowing. Absent when the chain cannot be walked — the caller decides
   *  what an unreadable chain means (design §7); it is never silently a short path. */
  path?: OverrideEntryLike[];
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
 * Lookup is a directory scan of THIS store's own directory, reading ids out of the filenames pi
 * writes (`<timestamp>_<id>.jsonl`) — not `SessionManager.list`, which filters by the cwd recorded in
 * each header and would make a renamed agent directory look like an empty store (see
 * {@link recordFiles}).
 *
 * NEW records live in a subdirectory of their own, because the two engines cannot share a namespace:
 * both spell ids into `[A-Za-z0-9._-]`, so neither can claim a prefix the other cannot produce, and
 * a directory holding both would have names that belong to two conversations at once — in whichever
 * direction it is read. Separate directories make each side's own injectivity sufficient.
 *
 * A PRE-EXISTING record is continued in place: looked up by the older spelling, which is injective
 * on its own terms, and appended to where it lies. Both spellings are the same v3 jsonl, so a
 * conversation started before this store keeps going rather than restarting empty. Nothing on disk
 * is rewritten.
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
  /** An empty record under `id`, ON DISK (see {@link materialize}) and not yet discoverable. Copying
   *  into it appends immediately, so a crash leaves a partial record in staging rather than a
   *  complete-looking one under the id. */
  const stage = (id: string): SessionManager => {
    mkdirSync(staging, { recursive: true });
    return materialize(SessionManager.create(cwd, staging, { id }), staging);
  };
  /** Fill a staged record and move it in — or leave nothing behind. The partial file is deleted on
   *  the way out and the failure is rethrown untouched: `fork` turns it into a coded result and
   *  inheritance falls back to an empty session, but neither can see `.staging`, which would
   *  otherwise accumulate a file per failed attempt (ENOSPC being the realistic repeat offender) in
   *  a directory nothing ever reads. */
  const fillStaged = (id: string, fill: (staged: SessionManager) => void): SessionManager => {
    const staged = stage(id);
    // WHERE the record is, so cleanup deletes the file that exists rather than the path it used to
    // have: after the rename, removing the staging path succeeds against nothing while the record it
    // was supposed to undo sits in the store.
    let published: string | undefined;
    try {
      fill(staged);
      // Publishing is a mkdir + rename, and both can fail (EACCES, a store root on another
      // filesystem) — a finished record stranded in staging is the same accumulation as a partial
      // one. NOT covered by a test: the tests reach a fill failure by making a copy throw, and there
      // is no equivalent injection point for rename without mocking node:fs for the whole file.
      published = publishStaged(staged);
      return SessionManager.open(published, own);
    } catch (error) {
      rmSync(published ?? staged.getSessionFile() ?? "", { force: true });
      throw error;
    }
  };
  /** Move a finished record into the store: one same-filesystem rename, so a reader sees the whole
   *  thing or nothing at all. Answers WHERE it landed — the caller opens it, and can undo it. */
  const publishStaged = (staged: SessionManager): string => {
    const file = staged.getSessionFile();
    if (!file) throw new Error(`staged record ${staged.getSessionId()} has no file to publish`);
    mkdirSync(own, { recursive: true });
    const target = join(own, basename(file));
    renameSync(file, target);
    return target;
  };
  /** Fork the named parent into `id`, or answer undefined so the caller starts empty. Every failure
   *  is a warn: a thread must not lose its first turn to an inheritance edge. */
  const inheritInto = async (sessionId: string, inherit: SessionInheritance): Promise<SessionManager | undefined> => {
    const found = locate(inherit.parentSession);
    if (!found) {
      log.warn(
        `[fastagent] session "${sessionId}" names parent "${inherit.parentSession}", which has no record — starting empty`,
      );
      return undefined;
    }
    try {
      // A parent that crashed mid tool-execution would otherwise pass its dangling tool_use down
      // to the child, whose very first request the provider then rejects.
      const parent = reconcileInterruptedToolCalls(SessionManager.open(found.path, found.dir));
      const cut = inheritanceCut(parent, inherit.branchHints);
      if (!cut) return undefined;
      return fillStaged(piSessionId(sessionId), (staged) => copyBranchForInheritance(parent, staged, cut.at));
    } catch (error) {
      // Unattributed on purpose: this spans reading the parent AND writing the child.
      log.warn(
        `[fastagent] could not inherit from "${inherit.parentSession}" into "${sessionId}" (${String(error)}) — starting empty`,
      );
      return undefined;
    }
  };
  /** The unreadable records the last listing reported, so a polled endpoint states the condition
   *  once rather than once a second. */
  let lastUnreadable = "";
  /** WHERE a session's record is, under either spelling — the one lookup every caller shares, so a
   *  fix to it (this store's own directory rather than pi's cwd-filtered listing) cannot reach three
   *  of the four. */
  const locate = (sessionId: string): { path: string; dir: string } | undefined => {
    const mine = recordFiles(own).find((f) => f.id === piSessionId(sessionId));
    if (mine) return { path: mine.path, dir: own };
    const legacy = recordFiles(root).find((f) => f.id === legacySessionId(sessionId));
    return legacy ? { path: legacy.path, dir: root } : undefined;
  };
  /** Open an existing record, or undefined. A closure rather than a method call, so `fork` cannot be
   *  broken by a caller that spreads this object into another one. */
  const openExisting = async (sessionId: string): Promise<SessionManager | undefined> => {
    const found = locate(sessionId);
    return found ? SessionManager.open(found.path, found.dir) : undefined;
  };
  return {
    async openOrCreate(sessionId, inherit) {
      const found = locate(sessionId);
      if (found) return reconcileInterruptedToolCalls(SessionManager.open(found.path, found.dir));
      mkdirSync(own, { recursive: true });
      // Inheritance is a CREATE-path decision: an existing session above ignores it entirely, which
      // is what makes it one-time by construction.
      if (inherit) {
        const inherited = await inheritInto(sessionId, inherit);
        if (inherited) return inherited;
      }
      // The CALLER's id in every message above; pi's spelling only where pi names the file.
      return materialize(SessionManager.create(cwd, own, { id: piSessionId(sessionId) }), own);
    },
    openIfExists: openExisting,
    applyProperties: (sessionId, writes) => applyProperties(() => openExisting(sessionId), writes),
    async list() {
      const files = recordFiles(own);
      const rows: SessionSummary[] = [];
      const unreadable: string[] = [];
      for (const file of files) {
        // A record this store did not write (the older spelling) cannot be decoded back to a Caller
        // id, and a row nobody can dial is worse than a row that is missing. It stays openable BY id.
        const session = callerSessionId(file.id);
        if (!session) continue;
        try {
          rows.push(summarize(session, SessionManager.open(file.path, own)));
        } catch (error) {
          // ONE unreadable record must not take the listing down — the other conversations are fine,
          // and a GUI that shows nothing is worse than one missing a row. But it must not vanish
          // silently either: that is the same conflation `sessions_unavailable` prevents one level
          // up, just per record. Named, with its reason, every time it is polled: a record that
          // cannot be read is a condition someone has to act on.
          unreadable.push(`${basename(file.path)} (${String(error)})`);
        }
        // A TURN for everything else. Reading a record is synchronous (pi parses the whole file and
        // builds its index), and this endpoint is POLLED — so without a yield the process stops for
        // the length of the whole listing, once a second, while SSE heartbeats and in-flight turns
        // wait. pi's own listing streamed and interleaved; this reads faster and must not take that
        // away.
        await new Promise((resolve) => setImmediate(resolve));
      }
      // NEWEST ACTIVITY first. The filenames sort by CREATION, so an old conversation that just
      // received a message would otherwise sit below a newer idle one — the wrong answer for the
      // column a conversation list is read by.
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      // Said when the SET changes, not on every poll: this endpoint is polled once a second or so,
      // and an unreadable record stays unreadable until someone acts on it.
      const reported = unreadable.join("; ");
      if (reported !== lastUnreadable) {
        lastUnreadable = reported;
        if (unreadable.length > 0) {
          log.warn(
            `[fastagent] ${unreadable.length} of ${files.length} session records in ${own} could not be read and are missing from this listing: ${reported}`,
          );
        }
      }
      return rows;
    },
    async fork(from, at, into, provenance) {
      const parent = await openExisting(from);
      if (!parent) throw new Error(`session "${from}" has no record`);
      // The port promises a NEW record, so the guarantee belongs here rather than in the one caller
      // that happens to check: two records under one id makes which one a lookup finds a matter of
      // directory order.
      if (await openExisting(into)) throw new Error(`session "${into}" already exists`);
      fillStaged(piSessionId(into), (staged) => {
        // METADATA FIRST, history last. pi has one leaf pointer and every append advances it, so
        // whatever is written last becomes the fork's `leafEntryId` — and a client opening a fresh
        // fork would find its head on an empty `custom` record instead of on the exchange it forked
        // at. The name and the provenance describe the record; the history is what the session IS.
        const name = parent.getSessionName();
        // The name travels: a fork of "Deploy notes" that lists as untitled is a row a user cannot
        // place. A client that wants "(copy)" calls `update({ name })`.
        if (name) staged.appendSessionInfo(name);
        stampProvenance(staged, provenance);
        // NOT reconciled: the repair appends at the parent's LEAF, which a copy stopping at `at` can
        // never reach — it would only write to the record being copied FROM. The child is reconciled
        // on its own first open, like every other record.
        copyBranchInto(parent, staged, at);
      });
    },
    async delete(sessionId) {
      const found = locate(sessionId);
      if (!found) return false;
      // A record that cannot be deleted must not report success — the caller turns the throw into a
      // coded failure, and the session is still there for the next attempt.
      rmSync(found.path);
      return true;
    },
  };
}

/**
 * The property write, for both backends: the ONE place that knows how pi records a property.
 *
 * ORDER IS THE POINT. pi has a single leaf pointer and every append advances it, so the leaf ends up
 * wherever the last write landed — which is why the move goes FIRST (the properties below it must
 * hang off the branch the caller asked for, not the one it left) and why a fork writes its metadata
 * before its history (session-store's `fork`). The handle is opened HERE, inside the caller's lease:
 * one taken earlier could be a snapshot of a run that finished in the window, and appending to it
 * would hang the property off a stale leaf.
 */
async function applyProperties(
  open: () => Promise<SessionManager | undefined>,
  writes: PropertyWrites,
): Promise<AppliedProperties | undefined> {
  const record = await open();
  if (!record) return undefined;
  const landed: SessionUpdateField[] = [];
  let moved = false;
  let failure: unknown;
  try {
    if (writes.leafEntryId !== undefined) {
      // A move to where the head ALREADY is asks for nothing: a client retry, or a UI firing on
      // every selection, must not grow the session. Compared against the PUBLISHED head, because
      // pi's leaf may be the anchor a previous move left there.
      if (publishedLeaf(record) !== writes.leafEntryId) {
        record.branch(writes.leafEntryId);
        moved = true;
      }
      landed.push("leafEntryId");
    }
    if (writes.model) {
      record.appendModelChange(writes.model.provider, writes.model.id);
      landed.push("model");
    }
    if (writes.thinkingLevel !== undefined) {
      record.appendThinkingLevelChange(writes.thinkingLevel);
      landed.push("thinkingLevel");
    }
    if (writes.name !== undefined) {
      record.appendSessionInfo(writes.name);
      landed.push("name");
    }
  } catch (error) {
    // Held, not rethrown: what already landed still has to be reported, and the report is the only
    // way a caller learns the record moved.
    failure = error;
  }
  // THE ANCHOR, outside the try so a failed property write cannot skip it — that is precisely the
  // case reporting a MOVE as landed. pi's `branch()` writes nothing (the leaf is runtime state, and
  // `open()` puts it back on the file's last entry), so a move nothing followed is forgotten the
  // moment anything reopens the record. Appending anything pins it; this appends only when nothing
  // else in the patch already did.
  if (moved && record.getLeafId() === writes.leafEntryId) {
    try {
      record.appendCustomEntry(LEAF_ANCHOR, {});
    } catch (error) {
      // The move is runtime-only and will not survive the next open, so it did NOT land: saying it
      // did is the one thing a partial report cannot afford. A first failure keeps its place — it is
      // what stopped the patch — and this one is reported when nothing else went wrong.
      landed.splice(landed.indexOf("leafEntryId"), 1);
      failure ??= error;
    }
  }
  // READ BACK, never echo: pi rewrites a name (newlines collapse, ends trim), and the settings a
  // path resolves to can change under a moved leaf. The caller reports THIS, so `state()` and
  // `list()` cannot disagree with what it said.
  const name = record.getSessionName();
  // The PUBLISHED head, not pi's: the anchor above is ours, and a client must be told the position
  // it asked for — the one it can find in `entries()`.
  const leafEntryId = publishedLeaf(record);
  let path: OverrideEntryLike[] | undefined;
  try {
    path = activePath(record);
  } catch (error) {
    // An unreadable chain is the caller's decision (design §7), not a silent short path. The writes
    // are already durable either way.
    log.warn(`[fastagent] session ${record.getSessionId()}: written, active path unreadable: ${String(error)}`);
  }
  return {
    landed,
    ...(failure !== undefined ? { failure } : {}),
    ...(name ? { name } : {}),
    ...(leafEntryId ? { leafEntryId } : {}),
    ...(path ? { path } : {}),
  };
}

/**
 * The record files in a directory, newest first — pi names them `<ISO timestamp>_<id>.jsonl`, so the
 * name sorts by time and carries the id without opening anything.
 *
 * OUR readdir, not pi's `SessionManager.list`, and the difference is the reason this exists: that one
 * filters by the cwd recorded in each header — right for a TUI showing "this project's sessions",
 * wrong for a repository, where renaming the agent directory made every conversation vanish from the
 * listing AND from lookup, so the next turn started an empty session on top of the old one. It also
 * swallows per-file faults, which a listing needs to see.
 *
 * ENOENT is the one condition that is not a fault: a store nobody has written to holds no records.
 * Anything else — an unreadable ancestor, a file where the directory should be — travels with its
 * code, because "this deployment has no conversations" is not an answer for a store we cannot read.
 */
function recordFiles(dir: string): { path: string; id: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    return [];
  }
  // UNORDERED. Lookup does not care, and `list()` sorts its rows by activity — a filename order kept
  // here would be one nobody consumes and the next reader has to prove is unused.
  return names
    .filter((name) => name.endsWith(RECORD_SUFFIX))
    .flatMap((name) => {
      // The FIRST underscore: the timestamp holds none, and an encoded id may hold several
      // (`piSessionId` escapes with `_`).
      const cut = name.indexOf("_");
      return cut < 0 ? [] : [{ path: join(dir, name), id: name.slice(cut + 1, -RECORD_SUFFIX.length) }];
    });
}

/** One record as a conversation-list row. Read out of the record itself rather than from pi's
 *  listing, which is not asked for one — so the fields mean exactly what they say: no sentinel
 *  standing in for "no first message", and `updatedAt` floored at the record's own creation (a
 *  fork's entries carry the SOURCE's timestamps, so a branch made today would otherwise sort into
 *  whenever the original was written — the one column a conversation list orders by). */
function summarize(session: string, record: SessionManager): SessionSummary {
  const entries = record.getEntries() as unknown as { type?: string; timestamp?: string; message?: unknown }[];
  const createdAt = Date.parse(record.getHeader()?.timestamp ?? "") || 0;
  // `|| 0` on both: an unparseable timestamp is NaN, and NaN in `updatedAt` serializes to `null` —
  // which the contract types as a number and a client sorts by.
  const lastAt = Date.parse(entries.at(-1)?.timestamp ?? "") || 0;
  const messages = entries.filter((e) => e.type === "message");
  const name = record.getSessionName();
  const preview = firstUserText(messages);
  return {
    session,
    ...(name ? { name } : {}),
    createdAt,
    updatedAt: Math.max(lastAt, createdAt),
    messageCount: messages.length,
    ...(preview ? { preview } : {}),
  };
}

/** The first user message with text in it, truncated by CODE POINT (a cut through a surrogate pair
 *  would put a lone half in the row, which renders as U+FFFD). A session opened with a caption-less
 *  photo has none, and answers undefined — a row without a preview, not a row claiming one. */
function firstUserText(messages: { message?: unknown }[]): string | undefined {
  for (const entry of messages) {
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "user") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => (block as { type?: string }).type === "text")
              .map((block) => (block as { text?: string }).text ?? "")
              .join(" ")
          : "";
    // Cut to UTF-16 units FIRST: a pasted megabyte would otherwise become a million-element array
    // on the way to keeping 200 of them. Two units per code point is the ceiling, so this cannot
    // take fewer characters than the slice below wants.
    if (text.trim()) return [...text.slice(0, PREVIEW_CHARS * 2)].slice(0, PREVIEW_CHARS).join("");
  }
  return undefined;
}

/** What pi names a record file. */
const RECORD_SUFFIX = ".jsonl";

/** How much of the first message a list row carries. A row, not a transcript. */
const PREVIEW_CHARS = 200;

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
function materialize(session: SessionManager, dir: string): SessionManager {
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
    applyProperties: (sessionId, writes) => applyProperties(async () => live.get(sessionId), writes),
    async list() {
      // The SAME row builder the disk store uses, ordered the same way: a backend difference here is
      // one an embedder discovers as a missing field (this one had no `preview` for exactly that
      // reason). Nothing to read from disk, so nothing can be unreadable.
      return [...live].map(([session, record]) => summarize(session, record)).sort((a, b) => b.updatedAt - a.updatedAt);
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
      // METADATA FIRST, history last — the same order the disk store writes in, and for the same
      // reason: pi has one leaf pointer, so whatever is appended last is where a client opening this
      // fork finds its head. That should be the exchange it was forked at, not a metadata record.
      // The name travels so a fork of "Deploy notes" is not an untitled row a user cannot place; a
      // client that wants "(copy)" calls `update({ name })`.
      const name = parent.getSessionName();
      if (name) staged.appendSessionInfo(name);
      stampProvenance(staged, provenance);
      copyBranchInto(parent, staged, at);
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
