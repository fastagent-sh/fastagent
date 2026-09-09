/** Session persistence for the `AgentSession` L0. */
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

/** The session RECORDS, as operations rather than as pi handles. */
export interface PiSessionRecordStore {
  openOrCreate(sessionId: string, inherit?: SessionInheritance): Promise<SessionManager>;
  /**
   * OPEN-EXISTING sibling: an unknown session answers undefined, never creates one — sessions are the data plane's
   * monopoly.
   */
  openIfExists(sessionId: string): Promise<SessionManager | undefined>;
  /** Write session properties, in the order pi's leaf pointer requires, and report what LANDED. */
  applyProperties(sessionId: string, writes: PropertyWrites): Promise<AppliedProperties | undefined>;
  /** Every record this store holds, in CALLER ids. */
  list(): Promise<SessionSummary[]>;
  /**
   * Copy `from`'s history up to entry `at` into a new record named `into`, stamped with `provenance` so a repeat of
   * the SAME fork can be recognised as one ({@link forkProvenance}) instead of becoming a second record or an
   * overwrite.
   */
  fork(from: string, at: string, into: string, provenance: string): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
}

/** A validated property patch, in the shape a RECORD takes it. */
export interface PropertyWrites {
  name?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  leafEntryId?: string;
}

/** What a property write actually did, and what the record holds after it. */
interface AppliedProperties {
  /** In write order. */
  landed: SessionUpdateField[];
  /** Why the rest stopped, if anything did. */
  failure?: unknown;
  /**
   * The record AFTER the writes — what the caller reports, rather than echoing the request. pi rewrites a name
   * (newlines collapse, ends trim), so the request is not what was stored.
   */
  name?: string;
  leafEntryId?: string;
  /**
   * The active path after the writes, for a caller that resolves settings against a model registry this layer has no
   * business knowing.
   */
  path?: OverrideEntryLike[];
}

/** A Caller's session id, as a name pi will accept. */
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
 * {@link piSessionId} backwards — what `list()` needs, because a session id belongs to the CALLER and a record name is
 * storage detail.
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

/** Disk-backed store under `dir`: restart the process, conversations continue. */
export function piSessionRecordStore(options: { dir: string; cwd?: string }): PiSessionRecordStore {
  const cwd = options.cwd ?? process.cwd();
  // Resolved against the workspace this store serves, not against wherever the process happens to have been started.
  const root = resolve(cwd, options.dir);
  const own = join(root, OWN_RECORDS_DIR);
  /** Where a forked record is finished before it becomes discoverable. */
  const staging = join(own, ".staging");
  /** An empty record under `id`, ON DISK (see {@link materialize}) and not yet discoverable. */
  const stage = (id: string): SessionManager => {
    mkdirSync(staging, { recursive: true });
    return materialize(SessionManager.create(cwd, staging, { id }), staging);
  };
  /** Fill a staged record and move it in — or leave nothing behind. */
  const fillStaged = (id: string, fill: (staged: SessionManager) => void): SessionManager => {
    const staged = stage(id);
    // WHERE the record is, so cleanup deletes the file that exists rather than the path it used to have.
    let published: string | undefined;
    try {
      fill(staged);
      // Publishing is a mkdir + rename, and both can fail (EACCES, a store root on another filesystem).
      published = publishStaged(staged);
      return SessionManager.open(published, own);
    } catch (error) {
      rmSync(published ?? staged.getSessionFile() ?? "", { force: true });
      throw error;
    }
  };
  /**
   * Move a finished record into the store: one same-filesystem rename, so a reader sees the whole thing or nothing at
   * all.
   */
  const publishStaged = (staged: SessionManager): string => {
    const file = staged.getSessionFile();
    if (!file) throw new Error(`staged record ${staged.getSessionId()} has no file to publish`);
    mkdirSync(own, { recursive: true });
    const target = join(own, basename(file));
    renameSync(file, target);
    return target;
  };
  /** Fork the named parent into `id`, or answer undefined so the caller starts empty. */
  const inheritInto = async (sessionId: string, inherit: SessionInheritance): Promise<SessionManager | undefined> => {
    const found = locate(inherit.parentSession);
    if (!found) {
      log.warn(
        `[fastagent] session "${sessionId}" names parent "${inherit.parentSession}", which has no record — starting empty`,
      );
      return undefined;
    }
    try {
      // A parent that crashed mid tool-execution would otherwise pass its dangling tool_use down to the child, whose
      // very first request the provider then rejects.
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
  /**
   * The unreadable records the last listing reported, so a polled endpoint states the condition once rather than once
   * a second.
   */
  let lastUnreadable = "";
  /**
   * WHERE a session's record is — the one lookup every caller shares, so a fix to it (this store's own directory
   * rather than pi's cwd-filtered listing) cannot reach three of the four.
   */
  const locate = (sessionId: string): { path: string; dir: string } | undefined => {
    const mine = recordFiles(own).find((f) => f.id === piSessionId(sessionId));
    return mine ? { path: mine.path, dir: own } : undefined;
  };
  /** Open an existing record, or undefined. */
  const openExisting = async (sessionId: string): Promise<SessionManager | undefined> => {
    const found = locate(sessionId);
    return found ? SessionManager.open(found.path, found.dir) : undefined;
  };
  return {
    async openOrCreate(sessionId, inherit) {
      const found = locate(sessionId);
      if (found) return reconcileInterruptedToolCalls(SessionManager.open(found.path, found.dir));
      mkdirSync(own, { recursive: true });
      // Inheritance is a CREATE-path decision: an existing session above ignores it entirely, which is what makes it
      // one-time by construction.
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
        // A name this store did not write cannot be decoded back to a Caller id, and a row nobody can dial is worse
        // than a row that is missing.
        const session = callerSessionId(file.id);
        if (!session) continue;
        try {
          rows.push(summarize(session, SessionManager.open(file.path, own)));
        } catch (error) {
          // ONE unreadable record must not take the listing down — the other conversations are fine, and a GUI that
          // shows nothing is worse than one missing a row.
          unreadable.push(`${basename(file.path)} (${String(error)})`);
        }
        // A TURN for everything else.
        await new Promise((resolve) => setImmediate(resolve));
      }
      // NEWEST ACTIVITY first.
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      // Said when the SET changes, not on every poll: this endpoint is polled once a second or so, and an unreadable
      // record stays unreadable until someone acts on it.
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
      // The port promises a NEW record, so the guarantee belongs here rather than in the one caller that happens to
      // check.
      if (await openExisting(into)) throw new Error(`session "${into}" already exists`);
      fillStaged(piSessionId(into), (staged) => {
        // METADATA FIRST, history last. pi has one leaf pointer and every append advances it, so whatever is written
        // last becomes the fork's `leafEntryId`.
        const name = parent.getSessionName();
        // The name travels: a fork of "Deploy notes" that lists as untitled is a row a user cannot place.
        if (name) staged.appendSessionInfo(name);
        stampProvenance(staged, provenance);
        // NOT reconciled: the repair appends at the parent's LEAF, which a copy stopping at `at` can never reach — it
        // would only write to the record being copied FROM.
        copyBranchInto(parent, staged, at);
      });
    },
    async delete(sessionId) {
      const found = locate(sessionId);
      if (!found) return false;
      // A record that cannot be deleted must not report success — the caller turns the throw into a coded failure,
      // and the session is still there for the next attempt.
      rmSync(found.path);
      return true;
    },
  };
}

/** The property write, for both backends: the ONE place that knows how pi records a property. */
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
      // A move to where the head ALREADY is asks for nothing: a client retry, or a UI firing on every selection, must
      // not grow the session.
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
    // Held, not rethrown: what already landed still has to be reported, and the report is the only way a caller
    // learns the record moved.
    failure = error;
  }
  // THE ANCHOR, outside the try so a failed property write cannot skip it.
  if (moved && record.getLeafId() === writes.leafEntryId) {
    try {
      record.appendCustomEntry(LEAF_ANCHOR, {});
    } catch (error) {
      // The move is runtime-only and will not survive the next open, so it did NOT land: saying it did is the one
      // thing a partial report cannot afford.
      landed.splice(landed.indexOf("leafEntryId"), 1);
      failure ??= error;
    }
  }
  // READ BACK, never echo: pi rewrites a name (newlines collapse, ends trim), and the settings a path resolves to can
  // change under a moved leaf.
  const name = record.getSessionName();
  // The PUBLISHED head, not pi's: the anchor above is ours, and a client must be told the position it asked for — the
  // one it can find in `entries()`.
  const leafEntryId = publishedLeaf(record);
  let path: OverrideEntryLike[] | undefined;
  try {
    path = activePath(record);
  } catch (error) {
    // An unreadable chain is the caller's decision (design §7), not a silent short path.
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
 * The record files in a directory, newest first — pi names them `<ISO timestamp>_<id>.jsonl`, so the name sorts by
 * time and carries the id without opening anything.
 */
function recordFiles(dir: string): { path: string; id: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    return [];
  }
  // UNORDERED.
  return names
    .filter((name) => name.endsWith(RECORD_SUFFIX))
    .flatMap((name) => {
      // The FIRST underscore: the timestamp holds none, and an encoded id may hold several (`piSessionId` escapes
      // with `_`).
      const cut = name.indexOf("_");
      return cut < 0 ? [] : [{ path: join(dir, name), id: name.slice(cut + 1, -RECORD_SUFFIX.length) }];
    });
}

/** One record as a conversation-list row. */
function summarize(session: string, record: SessionManager): SessionSummary {
  const entries = record.getEntries() as unknown as { type?: string; timestamp?: string; message?: unknown }[];
  const createdAt = Date.parse(record.getHeader()?.timestamp ?? "") || 0;
  // `|| 0` on both: an unparseable timestamp is NaN, and NaN in `updatedAt` serializes to `null` — which the contract
  // types as a number and a client sorts by.
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

/**
 * The first user message with text in it, truncated by CODE POINT (a cut through a surrogate pair would put a lone
 * half in the row, which renders as U+FFFD).
 */
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
    // Cut to UTF-16 units FIRST: a pasted megabyte would otherwise become a million-element array on the way to
    // keeping 200 of them.
    if (text.trim()) return [...text.slice(0, PREVIEW_CHARS * 2)].slice(0, PREVIEW_CHARS).join("");
  }
  return undefined;
}

/** What pi names a record file. */
const RECORD_SUFFIX = ".jsonl";

/** How much of the first message a list row carries. */
const PREVIEW_CHARS = 200;

/** Crash-safety reconciliation, run on every OPEN of an existing record. */
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

/** Where the records live, under the sessions directory the store is pointed at. */
const OWN_RECORDS_DIR = "agent-session";

/** Make a NEW record exist on disk before anyone can act on it. */
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
      // Keyed by the CALLER's id: the encoding exists to satisfy pi's filename rule, and in memory there are no
      // filenames.
      const existing = live.get(sessionId);
      if (existing) return reconcileInterruptedToolCalls(existing);
      const fresh = () => SessionManager.inMemory(cwd, { id: piSessionId(sessionId) });
      // Same semantics as the durable store, different mechanism: with no file to fork, the parent's path is copied
      // entry by entry.
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
      // The SAME row builder the disk store uses, ordered the same way.
      return [...live].map(([session, record]) => summarize(session, record)).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async fork(from, at, into, provenance) {
      const parent = live.get(from);
      if (!parent) throw new Error(`session "${from}" has no record`);
      // The port's promise, not the caller's: registering over a live session would replace its history outright.
      if (live.has(into)) throw new Error(`session "${into}" already exists`);
      // Entry-by-entry, like the in-memory inheritance path: there is no file to fork.
      const staged = SessionManager.inMemory(cwd, { id: piSessionId(into) });
      // METADATA FIRST, history last — the same order the disk store writes in, and for the same reason.
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
