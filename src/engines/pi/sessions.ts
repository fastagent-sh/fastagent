/**
 * Session persistence — the K-axis port and its first two backends.
 *
 * PiSessionStore is the consumer-owned port: open-or-create by opaque session id, plus one creation
 * option — inheritance. pi's full SessionRepo surface (list/open/create/delete) stays behind the
 * adapters; `fork` is surfaced only through {@link SessionInheritance}, never raw. The `Pi` prefix
 * is honest — `openOrCreate` returns pi's `Session`, so this is pi-coupled, not a neutral
 * persistence contract.
 *
 * Continuity = same backing store + same session id: in-memory continuity dies with the instance;
 * jsonl survives process restarts (disk is the truth).
 */
import { mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentMessage, Session, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { log } from "../../log.ts";

/**
 * Where a NEW session starts from, when it names a parent (participant-model.md §5: "a thread starts
 * from what the room knew"). Read only on the create path — an EXISTING session ignores it entirely,
 * which is what makes inheritance one-time by construction: no marker to persist, no decision to
 * retry per turn; the session existing IS the record that the decision was taken.
 */
export interface SessionInheritance {
  /** The session to fork from. Missing or unreadable → the new session starts empty, with a warn —
   *  context is not the ask, and losing it must not cost the turn. */
  parentSession: string;
  /** Opaque markers that MAY locate the branch point on the parent's active path (searched in
   *  message content, first hit wins, most recent occurrence). No match → the parent's present. */
  branchHints?: string[];
}

/** What fastagent needs from a session backend: open-or-create by opaque id. */
export interface PiSessionStore {
  openOrCreate(sessionId: string, inherit?: SessionInheritance): Promise<Session>;
}

/**
 * OPEN-EXISTING sibling of {@link PiSessionStore} (session-control.ts): an unknown session answers
 * `undefined`, never creates one — sessions are the data plane's monopoly. Two consumers:
 * - the OBSERVATION plane (`state()`/`entries()`), strictly read-only (design §16 invariant 4);
 * - the control plane's BOUNDARY writers (`set_model`/`set_thinking` append override records to the
 *   returned handle; `navigate` moves its leaf) after an existence check, under the run lease.
 * `openIfExists` skips the open-time crash reconciliation (that appends repair entries — a write
 * the observation plane must not perform). The boundary writers are safe WITHOUT it for two
 * different reasons: an override record is not a message, so it cannot create or pair with a
 * dangling tool_use; a `navigate` writes no message either, but it CAN expose one — parking the
 * leaf on an assistant entry whose tool results are now off-path is the dangling-pair state
 * {@link reconcileInterruptedToolCalls} exists for. That is repaired at the next `openOrCreate`,
 * which repairs AT THE LEAF — exactly where a move puts it.
 *
 * Writing MESSAGE-class records through this handle would bypass that repair: use `openOrCreate`
 * for anything that enters the transcript.
 */
export interface PiSessionReader {
  openIfExists(sessionId: string): Promise<Session | undefined>;
}

/**
 * Crash-safety reconciliation, run on every OPEN of an existing session.
 *
 * A turn that dies mid tool-execution leaves an assistant `tool_use` with no matching result (pi
 * persists the assistant message before the tool runs). The next turn would then hand the provider an
 * `assistant(tool_use) -> user` sequence that Anthropic/OpenAI reject — the session is poisoned. We
 * append an honest "interrupted" error result for each dangling call, restoring a valid transcript.
 * Tool side-effect idempotency stays the tool's responsibility (SPEC §6); this only restores
 * transcript validity, not exactly-once execution.
 *
 * Pairing is TURN-LOCAL: a tool_use is paired only by a toolResult that immediately follows it (up to
 * the next non-toolResult). tool-call ids are not unique across turns (a local model may restart ids
 * each response), so matching against the whole transcript could falsely settle a leaf call against an
 * earlier turn's identical id. Append-only logs can only repair a gap AT THE LEAF (last assistant
 * followed by nothing but its own results); an earlier gap is surfaced via log.warn rather than
 * "fixed" with an orphaned result that appending cannot place.
 *
 * The synthetic result splits its audiences: `content` (read by the model, may reach the end user)
 * stays neutral — it must NOT say "aborted" (pi's word for a user cancellation) or leak infra detail;
 * `details` carries the operational marker for developers and is never sent to the provider.
 */
async function reconcileInterruptedToolCalls(session: Session): Promise<void> {
  const { messages } = await session.buildContext();

  let leafIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      leafIdx = i;
      break;
    }
  }
  if (leafIdx === -1) return; // no assistant turn yet
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
    const result: AgentMessage = {
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
    };
    await session.appendMessage(result);
  }
}

/**
 * The entries on the session's ACTIVE path, root→leaf — what every last-wins read must walk.
 * `getEntries()` is the whole TREE: once `navigate` can move the leaf, the journal still carries
 * the abandoned branch, and reading it flat would run the session on a setting it moved away from.
 * Deliberately NOT `Session.getBranch()`: that walk is bounded by the last compaction's retained
 * window, which is the right bound for MODEL CONTEXT and the wrong one for settings — an override
 * recorded before a compaction is a preference, and it still governs the session after one.
 */
export async function activePathEntries(session: Session): Promise<SessionTreeEntry[]> {
  // LEAF FIRST, then the journal — the order is load-bearing, not incidental: `getEntries()` is a
  // SNAPSHOT, so reading it first would let any concurrent append (i.e. any turn in progress) leave
  // a leaf the snapshot cannot contain, and the integrity throw below would fire on a live session
  // instead of a corrupt one. This way the snapshot is always a superset of the leaf's chain.
  const leafId = await session.getLeafId();
  const entries = await session.getEntries();
  // A null leaf is pi's ROOT position (what `moveTo(null)` sets), so the active path is EMPTY — not
  // "the whole journal", which on a branched session would mean every abandoned branch at once.
  if (leafId === null) return [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  // A chain that is not intact THROWS: any other disposition returns a short path that reads like a
  // short session (every override and activation above the gap gone, the next turn silently on
  // assembly defaults). pi's storages already reject a leaf outside the journal in `getLeafId()`,
  // but the port is swappable — so the walk names it here rather than dying on `undefined.parentId`.
  const start = byId.get(leafId);
  if (!start) throw new Error(`session leaf "${leafId}" is missing from the journal`);
  const path: SessionTreeEntry[] = [];
  for (let cur = start; ; ) {
    path.push(cur);
    // A path cannot be longer than the journal it walks; anything more is a parentId cycle, which
    // would otherwise hang the turn with no `failed` event at all.
    if (path.length > entries.length) throw new Error(`session entry "${cur.id}" cycles through its parents`);
    if (!cur.parentId) break;
    const parent = byId.get(cur.parentId);
    if (!parent) throw new Error(`session entry "${cur.parentId}" is missing from the journal (parent of "${cur.id}")`);
    cur = parent;
  }
  return path.reverse(); // walked leaf→root; every consumer reads it root→leaf
}

// ── Inheritance: fork-on-first-open ───────────────────────────────────────────────────────
//
// The mechanism behind participant-model.md §5's rule, engine-side and channel-neutral: a channel
// only names WHERE a place branched from (scope.parentSession) and possibly at WHICH message
// (branchHints); how much is inherited and where the boundaries sit is decided here.
//
// Shape: fork the parent's ACTIVE PATH up to the branch point (everything — text, images, tool
// results — because they are session entries, not prompt text), then bound what the MODEL sees with
// one mechanical compaction mark (a plain string; zero model calls). Disk keeps the full copy —
// storage and context are different budgets (the fork is inspectable; the mark governs the window),
// and pi's context assembly honors the mark the same as a real compaction.

/** Inheritance window: at most this many exchanges of the parent reach the child's model context. */
const INHERIT_MAX_EXCHANGES = 50;
/** …and at most roughly this many tokens (~1/4 of a 200K context: generous, not everything). Both
 *  limits govern how far the window EXTENDS into older history — the newest exchange is a FLOOR,
 *  kept whole even when it alone exceeds the budget: the mark's boundary is entry-granular, and an
 *  inheritance that drops the exchange the thread branched off would be no inheritance at all. */
const INHERIT_MAX_TOKENS = 50_000;
/** Branch hints are IDS, not payloads: each one costs a scan over the parent's serialized path, and
 *  the wire accepts arbitrary arrays — so the engine caps them where the cost lives. */
const MAX_BRANCH_HINTS = 16;
const MAX_BRANCH_HINT_CHARS = 128;
/** A vision image is priced FLAT — what a provider bills for a resized image, roughly — because its
 *  base64 length (~1M chars for a photo) measures storage, not context: pricing it by chars would
 *  let one photo evict the whole text window. */
const INHERIT_IMAGE_TOKENS = 1_600;
/** The fork reads the whole parent journal into memory; beyond this it is skipped (empty session +
 *  warn) rather than stalling the thread's first turn. */
const FORK_MAX_BYTES = 32 * 1024 * 1024;

function isUserMessage(entry: SessionTreeEntry | undefined): boolean {
  return entry?.type === "message" && entry.message.role === "user";
}

/** Rough token estimate for windowing — text at chars/4, images flat. Precision is not the point:
 *  the window is a budget, and being 20% off moves a boundary by an exchange, not correctness. */
function estimateMessageTokens(message: AgentMessage): number {
  // AgentMessage is a role-keyed union and not every member carries `content` — read it loosely.
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  // Blocks are role-dependent unions; the estimate only needs `type`/`text`, so read them loosely.
  for (const block of content as { type?: string; text?: string }[]) {
    if (block.type === "image") tokens += INHERIT_IMAGE_TOKENS;
    else if (typeof block.text === "string") tokens += Math.ceil(block.text.length / 4);
    else tokens += Math.ceil(JSON.stringify(block).length / 4);
  }
  return tokens;
}

function estimateEntryTokens(entry: SessionTreeEntry): number {
  if (entry.type !== "message") return 0;
  return estimateMessageTokens(entry.message);
}

/** A compaction entry's summary and retained tail DO reach the model — they are the floor under
 *  every window that starts above the compaction, so the budget must count them. */
function estimateCompactionTokens(entry: SessionTreeEntry | undefined): number {
  if (entry?.type !== "compaction") return 0;
  let tokens = Math.ceil(entry.summary.length / 4);
  for (const message of entry.retainedTail ?? []) tokens += estimateMessageTokens(message);
  return tokens;
}

/**
 * Find the fork target on the parent's active path: the LAST message whose content carries a hint
 * (the most recent turn that talked about that message), extended forward to the end of its exchange
 * — forking mid-exchange would inherit a question without its answer. Hints are tried in caller
 * order; the first that matches anywhere wins. No match → undefined (the caller forks the present).
 */
function locateBranchPoint(path: SessionTreeEntry[], hints: string[]): string | undefined {
  const usable = hints
    .filter((hint) => hint.length > 0 && hint.length <= MAX_BRANCH_HINT_CHARS)
    .slice(0, MAX_BRANCH_HINTS);
  if (usable.length < hints.length) {
    log.warn(
      `[fastagent] ignored ${hints.length - usable.length} branch hint(s) (over ${MAX_BRANCH_HINTS} hints or ${MAX_BRANCH_HINT_CHARS} chars each) — hints are message ids, not payloads`,
    );
  }
  if (usable.length === 0) return undefined;
  // Serialize each message ONCE — the scan is hints × entries, and stringify must not sit in the
  // inner loop. The whole message, not just content: shape-agnostic, and a hint is a platform id —
  // a false positive would need the id to appear outside content, which is where ids live anyway.
  const serialized = path.map((entry) => (entry.type === "message" ? JSON.stringify(entry.message) : ""));
  for (const hint of usable) {
    for (let i = path.length - 1; i >= 0; i--) {
      if (!serialized[i]?.includes(hint)) continue;
      let j = i + 1;
      while (j < path.length && !isUserMessage(path[j])) j++;
      return path[j - 1]?.id;
    }
  }
  return undefined;
}

/**
 * Bound what the child's MODEL CONTEXT starts with: keep the newest exchange unconditionally, extend
 * older while both window limits hold, and mark the boundary with a mechanical compaction entry.
 * Entries above the parent's own last compaction are already outside model context and need no mark;
 * a child whose visible history fits the window gets no mark at all.
 */
async function markInheritanceWindow(child: Session): Promise<void> {
  const path = await activePathEntries(child);
  let scanFrom = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]?.type === "compaction") {
      scanFrom = i + 1;
      break;
    }
  }
  const scanned = path.slice(scanFrom);
  // The compaction's own summary + retained tail reach the model regardless of where the window
  // lands, so they charge the budget as a base cost — not estimating them would over-admit.
  const baseTokens = estimateCompactionTokens(path[scanFrom - 1]);
  const starts: number[] = [];
  scanned.forEach((entry, i) => {
    if (isUserMessage(entry)) starts.push(i);
  });
  if (starts.length <= 1) return; // zero or one visible exchange — nothing to cut
  const suffixTokens = new Array<number>(scanned.length + 1).fill(0);
  for (let i = scanned.length - 1; i >= 0; i--) {
    const entry = scanned[i];
    suffixTokens[i] = (suffixTokens[i + 1] ?? 0) + (entry ? estimateEntryTokens(entry) : 0);
  }
  let chosen = starts.length - 1;
  for (let k = starts.length - 2; k >= 0; k--) {
    const exchanges = starts.length - k;
    const startIdx = starts[k];
    if (startIdx === undefined) break;
    if (exchanges > INHERIT_MAX_EXCHANGES || baseTokens + (suffixTokens[startIdx] ?? 0) > INHERIT_MAX_TOKENS) break;
    chosen = k;
  }
  if (chosen === 0) return; // the whole visible history fits the window
  const boundaryIdx = starts[chosen];
  if (boundaryIdx === undefined) return;
  const boundary = scanned[boundaryIdx];
  if (boundary === undefined) return;
  await child.appendCompaction(
    `Inherited from the parent conversation; ${chosen} earlier exchange(s) are not shown.`,
    boundary.id,
    (suffixTokens[0] ?? 0) - (suffixTokens[boundaryIdx] ?? 0),
  );
}

/**
 * The backend surface session creation needs. Its one contract: **`id` resolves to a complete
 * session or to nothing, never to a half** — `openOrCreate` short-circuits on EXISTENCE, so a
 * newborn discovered before its entries, repair and window mark are written reads as "the decision
 * was taken" forever. pi's own `create`/`fork` publish first and append after, which is why this
 * seam exists. Re-attempting after a failure is therefore safe — the failed attempt left nothing to
 * collide with. CONCURRENT creation of one id is a different question, not answered here: the
 * serving path serializes it with the single-writer lease before reaching any store.
 */
interface SessionBackend<M> {
  find(id: string): Promise<M | undefined>;
  open(meta: M): Promise<Session>;
  /**
   * Build the session for `id` where nothing can observe it, then publish it in one indivisible
   * step. `from` forks the parent's active path up to `atEntryId`; omitted, the session starts
   * empty. `fill` writes everything the newborn must be born with — a throw from it publishes
   * nothing.
   */
  createAtomically(
    id: string,
    from: { meta: M; atEntryId: string } | undefined,
    fill: (draft: Session) => Promise<void>,
  ): Promise<Session>;
  /** Journal size, when the backend has one — guards the read-everything fork. */
  bytes?(meta: M): Promise<number>;
}

/**
 * The create-with-parent path (the open path never reaches here) — SEMANTICS only: where to branch
 * and what the newborn is born with. Writing and publishing it is
 * {@link SessionBackend.createAtomically}'s contract.
 *
 * Every failure lands on "start empty + warn": a thread must not lose its first turn to an
 * inheritance edge. The fallback is simply the next attempt — each one is a complete transaction, so
 * the failed one left nothing to collide with.
 */
async function createInheriting<M>(
  backend: SessionBackend<M>,
  id: string,
  inherit: SessionInheritance,
  parentId: string,
  maxBytes: number,
): Promise<Session> {
  const startEmpty = (): Promise<Session> => backend.createAtomically(id, undefined, async () => {});
  const parentMeta = await backend.find(parentId);
  if (!parentMeta) {
    log.warn(`[fastagent] session "${id}" names parent "${parentId}", which does not exist — starting empty`);
    return startEmpty();
  }
  if (backend.bytes) {
    const bytes = await backend.bytes(parentMeta).catch(() => 0);
    if (bytes > maxBytes) {
      log.warn(
        `[fastagent] parent session "${parentId}" is ${bytes} bytes (limit ${maxBytes}) — starting empty rather than stalling the first turn`,
      );
      return startEmpty();
    }
  }
  try {
    const parent = await backend.open(parentMeta);
    const path = await activePathEntries(parent);
    const leaf = path[path.length - 1];
    if (leaf !== undefined) {
      const hints = inherit.branchHints ?? [];
      const at = locateBranchPoint(path, hints);
      if (at === undefined && hints.length > 0) {
        log.warn(
          `[fastagent] no branch hint matched in parent "${parentId}" — inheriting from its present instead of the branch point`,
        );
      }
      // The one repair that must run before the child is visible: a mid-turn parent forks with a
      // dangling tool call at its leaf, which would hand the provider an invalid transcript.
      return await backend.createAtomically(id, { meta: parentMeta, atEntryId: at ?? leaf.id }, async (draft) => {
        await reconcileInterruptedToolCalls(draft);
        await markInheritanceWindow(draft);
      });
    }
    log.debug(`[fastagent] parent session "${parentId}" is empty — nothing to inherit`);
  } catch (error) {
    // Unattributed on purpose: this spans reading the parent AND writing the child, so the fault may
    // belong to either — a torn parent journal, or a store that cannot publish.
    log.warn(`[fastagent] could not inherit from "${parentId}" into "${id}" (${String(error)}) — starting empty`);
  }
  return startEmpty();
}

/** In-process store (pi InMemorySessionRepo). Continuity lives and dies with the instance. */
export function inMemorySessionStore(): PiSessionStore & PiSessionReader {
  const repo = new InMemorySessionRepo();
  const backend: SessionBackend<Awaited<ReturnType<InMemorySessionRepo["list"]>>[number]> = {
    find: async (id) => (await repo.list()).find((m) => m.id === id),
    open: (m) => repo.open(m),
    // No draft realm needed: nothing partial outlives the process, and `fill` still runs before the
    // session reaches any caller.
    createAtomically: async (id, from, fill) => {
      const draft = from
        ? await repo.fork(from.meta, { id, entryId: from.atEntryId, position: "at" })
        : await repo.create({ id });
      await fill(draft);
      return draft;
    },
  };
  return {
    async openOrCreate(sessionId, inherit) {
      const existing = (await repo.list()).find((m) => m.id === sessionId);
      if (!existing) {
        if (inherit) return createInheriting(backend, sessionId, inherit, inherit.parentSession, FORK_MAX_BYTES);
        return repo.create({ id: sessionId });
      }
      const session = await repo.open(existing);
      await reconcileInterruptedToolCalls(session);
      return session;
    },
    async openIfExists(sessionId) {
      const existing = (await repo.list()).find((m) => m.id === sessionId);
      return existing ? repo.open(existing) : undefined;
    },
  };
}

/**
 * Disk-backed store (pi JsonlSessionRepo under `dir`): restart the process, conversations continue.
 * `cwd` is recorded in session metadata; defaults to process.cwd().
 */
export function jsonlSessionStore(options: {
  dir: string;
  cwd?: string;
  /** Inheritance guard override (tests): parent journals above this are not forked. Default 32 MiB. */
  forkMaxBytes?: number;
}): PiSessionStore & PiSessionReader {
  const cwd = options.cwd ?? process.cwd();
  const forkMaxBytes = options.forkMaxBytes ?? FORK_MAX_BYTES;
  // Resolve ONCE, by pi's rule (`NodeExecutionEnv.absolutePath` is `resolve(cwd, path)`): the direct
  // fs calls below resolve against process.cwd() instead, and a relative `dir` would straddle both.
  const root = resolve(cwd, options.dir);
  const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd }), sessionsRoot: root });
  // The draft realm: a sibling root INSIDE the store root but OUTSIDE every lookup — `list({ cwd })`
  // scans only `<root>/<encodedCwd>`, and a cwd-less `list()` scans `<root>/*/​*.jsonl`, one level,
  // which `.drafts/<encodedCwd>/*.jsonl` sits below. This is what makes creation atomic on a backend
  // that has no transactions: everything before the rename is invisible and repeatable, everything
  // after it is complete. EVERY creation stages here, forked or empty — hence `.drafts`, not a name
  // about inheritance.
  //
  // A crash, or a handled failure once the draft file exists (a throw from `fill`, or from the
  // rename), leaves it behind. Drafts are never resumed, so staleness cannot poison anything — but
  // nothing unlinks them either.
  const draftRepo = new JsonlSessionRepo({
    fs: new NodeExecutionEnv({ cwd }),
    sessionsRoot: join(root, ".drafts"),
  });
  const backend: SessionBackend<Awaited<ReturnType<JsonlSessionRepo["list"]>>[number]> = {
    find: async (id) => (await repo.list({ cwd })).find((m) => m.id === id),
    open: (m) => repo.open(m),
    createAtomically: async (id, from, fill) => {
      // `fork` opens the source by its metadata's absolute path, so the draft repo reads the real
      // repo's parent file directly while writing into its own root.
      const draft = from
        ? await draftRepo.fork(from.meta, { cwd, id, entryId: from.atEntryId, position: "at" })
        : await draftRepo.create({ id, cwd });
      await fill(draft);
      // The interface erases the metadata generic; a jsonl draft's metadata always carries `path`.
      const draftPath = ((await draft.getMetadata()) as unknown as { path: string }).path;
      // `<root>/.drafts/<encodedCwd>/<file>` → `<root>/<encodedCwd>/<file>`: the draft's own
      // parent directory NAME is pi's cwd encoding, already computed — read it back rather than
      // re-deriving it, and rather than borrowing the parent session's path (a parentless draft has
      // none). Same filesystem, so the rename is atomic; the real directory may not exist yet when
      // this store has never created a session for this cwd.
      const target = join(root, basename(dirname(draftPath)), basename(draftPath));
      await mkdir(dirname(target), { recursive: true });
      await rename(draftPath, target);
      const published = (await repo.list({ cwd })).find((m) => m.path === target);
      if (!published) throw new Error(`published session vanished: ${target}`);
      return repo.open(published);
    },
    bytes: async (m) => (await stat(m.path)).size,
  };
  return {
    async openOrCreate(sessionId, inherit) {
      // Caller-provided ids land in jsonl FILENAMES — encode anything unsafe before it reaches disk.
      const id = encodeSessionId(sessionId);
      // Scope the lookup to this store's cwd: two stores sharing a sessionsRoot must not open each
      // other's sessions (pi groups sessions by project dir).
      const existing = (await repo.list({ cwd })).find((m) => m.id === id);
      if (!existing) {
        if (inherit)
          return createInheriting(backend, id, inherit, encodeSessionId(inherit.parentSession), forkMaxBytes);
        return repo.create({ id, cwd });
      }
      const session = await repo.open(existing);
      await reconcileInterruptedToolCalls(session);
      return session;
    },
    async openIfExists(sessionId) {
      const id = encodeSessionId(sessionId);
      const existing = (await repo.list({ cwd })).find((m) => m.id === id);
      return existing ? repo.open(existing) : undefined;
    },
  };
}

/**
 * Filename-safe encoding, INJECTIVE: `[A-Za-z0-9._-]` verbatim, everything else `%XX` (one byte) or
 * `%uXXXX` (above it). Two different ids must never encode alike: the encoded id is what
 * `openOrCreate` matches on, so a collision is two conversations resolving to ONE session, and —
 * since `parentSession` comes through the same encoder — one inheriting from the wrong room. Not the
 * same thing as a filename clash: a file is `<timestamp>_<id>.jsonl`, and identity is the `id` its
 * metadata carries, not the name on disk.
 *
 * Injectivity is what the previous form lacked: it padded to a MINIMUM of two hex digits, so an
 * escape run could be re-split — `"\u0100"` and `"\u0010" + "0"` both produced `"%100"`. Every
 * escape now has a self-describing width, so no two inputs can produce one output. ASCII ids — every
 * id the built-in channels mint — encode exactly as before, so existing session FILES keep their
 * names; only non-ASCII ids (a custom `route()` could mint one) change, and those are the ones that
 * were unsafe anyway.
 */
function encodeSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x100
      ? `%${code.toString(16).toUpperCase().padStart(2, "0")}`
      : `%u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  });
}
