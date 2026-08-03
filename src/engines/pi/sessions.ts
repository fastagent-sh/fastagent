/**
 * Session persistence — the K-axis port and its first two backends.
 *
 * PiSessionStore is the consumer-owned port: open-or-create by opaque session id, nothing more.
 * pi's full SessionRepo surface (list/open/create/delete/fork) stays behind the adapters. The `Pi`
 * prefix is honest — `openOrCreate` returns pi's `Session`, so this is pi-coupled, not a neutral
 * persistence contract.
 *
 * Continuity = same backing store + same session id: in-memory continuity dies with the instance;
 * jsonl survives process restarts (disk is the truth).
 */
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentMessage, Session, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { log } from "../../log.ts";

/** What fastagent needs from a session backend: open-or-create by opaque id. */
export interface PiSessionStore {
  openOrCreate(sessionId: string): Promise<Session>;
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

/** Corruption warns are per (leaf, condition) so a persistent broken chain does not repeat on every
 *  turn and every observation poll — the dedup discipline `resolveHarnessActiveToolNames` sets. */
const warnedBrokenChains = new Set<string>();
function warnOnce(key: string, message: string): void {
  (warnedBrokenChains.has(key) ? log.debug : log.warn)(message);
  warnedBrokenChains.add(key);
}

/**
 * The entries on the session's ACTIVE path, root→leaf — what every last-wins read must walk.
 * `getEntries()` is the whole TREE: once `navigate` can move the leaf, the journal still carries
 * the abandoned branch, and reading it flat would run the session on a setting it moved away from.
 * Deliberately NOT `Session.getBranch()`, which stops at a compaction: a compaction bounds the
 * MODEL CONTEXT, while an override recorded before one still governs the session.
 */
export async function activePathEntries(session: Session): Promise<SessionTreeEntry[]> {
  const entries = await session.getEntries();
  const leafId = await session.getLeafId();
  if (leafId === null) return entries; // nothing recorded a leaf yet — the journal is the path
  const byId = new Map(entries.map((e) => [e.id, e]));
  if (!byId.has(leafId)) {
    // A leaf naming an entry the journal does not hold is corruption (a rebuilt or pruned
    // repository), not an empty path — returning [] would silently drop every override and
    // activation and run the session on the assembly defaults. Warn and read the journal flat, the
    // pre-navigate behavior: wrong on a branched session, but never silently settings-less.
    warnOnce(
      `missing:${leafId}`,
      `[fastagent] session leaf "${leafId}" is not in the journal — reading entries flat (was the repository rebuilt?)`,
    );
    return entries;
  }
  const path: SessionTreeEntry[] = [];
  const seen = new Set<string>();
  for (let cur = byId.get(leafId); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    if (seen.has(cur.id)) {
      // A parentId cycle is corruption too, and truncating silently would hand back a partial
      // settings basis that reads like a short session.
      warnOnce(
        `cycle:${cur.id}`,
        `[fastagent] session entry "${cur.id}" cycles through its parents — path truncated there`,
      );
      break;
    }
    seen.add(cur.id);
    path.unshift(cur);
  }
  return path;
}

/** In-process store (pi InMemorySessionRepo). Continuity lives and dies with the instance. */
export function inMemorySessionStore(): PiSessionStore & PiSessionReader {
  const repo = new InMemorySessionRepo();
  return {
    async openOrCreate(sessionId) {
      const existing = (await repo.list()).find((m) => m.id === sessionId);
      if (!existing) return repo.create({ id: sessionId });
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
export function jsonlSessionStore(options: { dir: string; cwd?: string }): PiSessionStore & PiSessionReader {
  const cwd = options.cwd ?? process.cwd();
  const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd }), sessionsRoot: options.dir });
  return {
    async openOrCreate(sessionId) {
      // Caller-provided ids land in jsonl FILENAMES — encode anything unsafe before it reaches disk.
      const id = encodeSessionId(sessionId);
      // Scope the lookup to this store's cwd: two stores sharing a sessionsRoot must not open each
      // other's sessions (pi groups sessions by project dir).
      const existing = (await repo.list({ cwd })).find((m) => m.id === id);
      if (!existing) return repo.create({ id, cwd });
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

/** Injective filename-safe encoding: [A-Za-z0-9._-] verbatim, the rest %-escaped. */
function encodeSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}
