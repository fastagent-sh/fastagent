/**
 * Session persistence for the `AgentSession` L0 — open-or-create a durable record by the Caller's
 * opaque session id, on pi-coding-agent's `SessionManager` (the v3 jsonl every pi surface reads).
 *
 * The harness path's sibling is sessions.ts, which speaks pi-agent-core's `Session` instead. Both
 * write the same file format; they differ in which pi class reads it. That one retires with the
 * harness L0.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";
import { type SessionInheritance, copyBranchInto, forkForInheritance, inheritanceCut } from "./session-inheritance.ts";

/** What the AgentSession L0 needs from a session backend: open-or-create by opaque id, plus the one
 *  creation option — where a NEW session starts from (session-inheritance.ts). */
export interface PiSessionRecordStore {
  openOrCreate(sessionId: string, inherit?: SessionInheritance): Promise<SessionManager>;
  /** OPEN-EXISTING sibling: an unknown session answers undefined, never creates one — sessions are
   *  the data plane's monopoly. This is what the control plane reads and writes boundary records
   *  through, so a mutation on an unknown id is rejected rather than minted into a ghost record. */
  openIfExists(sessionId: string): Promise<SessionManager | undefined>;
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
 * directory. The harness path draws names from the same character set (it produces `s42` for a room
 * literally called `s42`, which is also this encoding of `42`), so sharing a directory would make
 * some names ambiguous no matter how either side spells them.
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
 * NEW records live in a subdirectory of their own, because the two engines cannot share a namespace:
 * both spell ids into `[A-Za-z0-9._-]`, so neither can claim a prefix the other cannot produce, and
 * a directory holding both would have names that belong to two conversations at once — in whichever
 * direction it is read. Separate directories make each side's own injectivity sufficient.
 *
 * An EXISTING harness record is still continued in place: it is looked up by that path's spelling,
 * which is injective on its own terms, and appended to where it lies. Both engines read the same v3
 * jsonl, so a conversation started before this engine keeps going rather than restarting empty.
 *
 * That continuity is ONE-WAY, and cannot be otherwise while both engines exist: the harness store
 * finds records by its own spelling, so pointing it at this subdirectory would put it back in the
 * ambiguous namespace this separation removes — its `s42` lookup would match the record this engine
 * wrote for `42`. So a conversation STARTED under FASTAGENT_ENGINE=session restarts empty if the
 * switch is turned off. The switch is a migration aid, not a supported toggle, and it disappears
 * with the harness path; a deployment that has run on it should stay on it.
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
  const own = join(options.dir, OWN_RECORDS_DIR);
  /** Where a forked record is finished before it becomes discoverable. A SUBDIRECTORY of the store,
   *  so `list()` (one level, `*.jsonl`) never sees a record that is still being prepared. */
  const staging = join(own, ".staging");
  /** Fork the named parent into `id`, or answer undefined so the caller starts empty. Every failure
   *  is a warn: a thread must not lose its first turn to an inheritance edge. */
  const inheritInto = async (id: string, inherit: SessionInheritance): Promise<SessionManager | undefined> => {
    const parentId = piSessionId(inherit.parentSession);
    const found =
      (await SessionManager.list(cwd, own)).find((r) => r.id === parentId) ??
      (await SessionManager.list(cwd, options.dir)).find((r) => r.id === legacySessionId(inherit.parentSession));
    if (!found) {
      log.warn(
        `[fastagent] session "${id}" names parent "${inherit.parentSession}", which has no record — starting empty`,
      );
      return undefined;
    }
    try {
      const parentDir = found.id === parentId ? own : options.dir;
      mkdirSync(staging, { recursive: true });
      const staged = forkForInheritance({
        // A parent that crashed mid tool-execution would otherwise pass its dangling tool_use down
        // to the child, whose very first request the provider then rejects.
        parent: reconcileInterruptedToolCalls(SessionManager.open(found.path, parentDir)),
        id,
        cwd,
        stagingDir: staging,
        branchHints: inherit.branchHints,
      });
      if (!staged) return undefined;
      // Publish only once the record is complete: same-filesystem rename, so a reader sees the whole
      // thing or nothing at all.
      const stagedFile = staged.getSessionFile();
      if (!stagedFile) return staged; // non-persisting backend: nothing to publish
      const target = join(own, basename(stagedFile));
      renameSync(stagedFile, target);
      return SessionManager.open(target, own);
    } catch (error) {
      // Unattributed on purpose: this spans reading the parent AND writing the child.
      log.warn(
        `[fastagent] could not inherit from "${inherit.parentSession}" into "${id}" (${String(error)}) — starting empty`,
      );
      return undefined;
    }
  };
  return {
    async openOrCreate(sessionId, inherit) {
      const id = piSessionId(sessionId);
      const mine = (await SessionManager.list(cwd, own)).find((r) => r.id === id);
      if (mine) return reconcileInterruptedToolCalls(SessionManager.open(mine.path, own));
      const legacy = (await SessionManager.list(cwd, options.dir)).find((r) => r.id === legacySessionId(sessionId));
      if (legacy) return reconcileInterruptedToolCalls(SessionManager.open(legacy.path, options.dir));
      mkdirSync(own, { recursive: true });
      // Inheritance is a CREATE-path decision: an existing session above ignores it entirely, which
      // is what makes it one-time by construction.
      if (inherit) {
        const inherited = await inheritInto(id, inherit);
        if (inherited) return inherited;
      }
      return publish(SessionManager.create(cwd, own, { id }), own);
    },
    async openIfExists(sessionId) {
      const id = piSessionId(sessionId);
      const mine = (await SessionManager.list(cwd, own)).find((r) => r.id === id);
      if (mine) return SessionManager.open(mine.path, own);
      const legacy = (await SessionManager.list(cwd, options.dir)).find((r) => r.id === legacySessionId(sessionId));
      return legacy ? SessionManager.open(legacy.path, options.dir) : undefined;
    },
  };
}

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
    async openOrCreate(sessionId, inherit) {
      // Keyed by the CALLER's id: the encoding exists to satisfy pi's filename rule, and in memory
      // there are no filenames — two rooms whose encodings collide must still not share a map slot.
      const existing = live.get(sessionId);
      if (existing) return reconcileInterruptedToolCalls(existing);
      const created = SessionManager.inMemory(cwd, { id: piSessionId(sessionId) });
      live.set(sessionId, created);
      if (inherit) {
        // Same semantics as the durable store, different mechanism: with no file to fork, the
        // parent's path is copied entry by entry. Inheritance is a property of the CONTRACT, not of
        // the medium — a caller must not get a thread that forgot its room because the store happens
        // to be in memory.
        const parent = live.get(inherit.parentSession);
        if (!parent) {
          log.warn(
            `[fastagent] session "${sessionId}" names parent "${inherit.parentSession}", which has no record — starting empty`,
          );
          return created;
        }
        try {
          const cut = inheritanceCut(reconcileInterruptedToolCalls(parent), inherit.branchHints);
          if (cut) copyBranchInto(parent, created, cut.at);
        } catch (error) {
          log.warn(
            `[fastagent] could not inherit from "${inherit.parentSession}" into "${sessionId}" (${String(error)}) — starting empty`,
          );
        }
      }
      return created;
    },
    async openIfExists(sessionId) {
      return live.get(sessionId);
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
