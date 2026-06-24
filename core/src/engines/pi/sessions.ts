/**
 * Session persistence — the K-axis port and its first two backends.
 *
 * PiSessionStore is the consumer-owned port: exactly what the harness factory needs
 * (open-or-create by opaque session id) and nothing more. pi's full SessionRepo
 * surface (list/open/create/delete/fork, backend-specific create options) stays
 * behind the adapters — the invoke path never needs it, and backend-specific
 * requirements (jsonl's `cwd`) stay out of the port.
 *
 * The name carries the `Pi` prefix on purpose: `openOrCreate` returns pi's `Session`,
 * so this port is pi-coupled, not an engine-neutral persistence contract. A neutral
 * session-log port would be a separate abstraction, justified only once a second engine
 * provides the real requirement.
 *
 * Continuity contract: same backing store + same session id = same conversation.
 *   - in-memory: continuity bound to the store INSTANCE (gone on restart; tests/embedding);
 *   - jsonl: continuity survives process restarts (disk is the truth) — faithful to
 *     local pi, which persists sessions too.
 *
 * Node composition-root module (IO policy, see definition.ts): may touch the disk
 * via pi's repos; the invoke path itself stays disk-free.
 */
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentMessage, Session } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/** What fastagent needs from a session backend: open-or-create by opaque id. */
export interface PiSessionStore {
  openOrCreate(sessionId: string): Promise<Session>;
}

/**
 * Crash-safety reconciliation, run on every OPEN of an existing session.
 *
 * A turn that dies mid tool-execution leaves the session with an assistant tool_use that
 * has no matching tool result: pi persists the assistant message at `message_end` — BEFORE
 * the tool runs — and `buildSessionContext` does not repair the gap. The next turn would
 * then hand the provider an `assistant(tool_use) -> user` sequence that Anthropic/OpenAI
 * reject, so a retry after a crash fails outright (the session is "poisoned"). We append an
 * honest "interrupted" error tool result for each dangling call, restoring a valid transcript
 * so the next turn proceeds and the model can re-decide.
 *
 * Tool side-effect idempotency stays the tool's responsibility (SPEC §6); this only restores
 * transcript validity, it does not promise the interrupted tool ran exactly once.
 *
 * Pairing is TURN-LOCAL, never transcript-global: a tool_use is paired only by a toolResult
 * that FOLLOWS it (append-only — a result always lands after the assistant that requested it).
 * tool-call ids are not guaranteed unique across turns (model-neutral: a local/custom model may
 * restart ids at `call-1` each response), so matching against the whole transcript would falsely
 * "settle" the leaf's call against an earlier turn's identical id and skip the repair.
 *
 * Append-only logs can only repair a gap AT THE LEAF (the last assistant followed by nothing but
 * its own toolResults): appending the missing result there yields a valid `assistant -> toolResults`
 * run. We still scan EVERY assistant turn-locally so a gap that is NOT at the leaf — an earlier
 * assistant's call, or a leaf call already followed by later history — is surfaced via `console.warn`
 * rather than silently ignored or "fixed" with an orphaned result that appending cannot place
 * correctly. (Mid-history gaps are unreachable in the reconcile-on-open design — we reconcile before
 * any later turn is appended — so the guard exists for forks/navigation or pre-fix sessions.)
 *
 * The synthetic result has three audiences, so it splits them deliberately:
 *   - `content` is read by the MODEL next turn (and may be relayed to the end user). It stays
 *     neutral and decision-guiding. It must NOT say "aborted" — pi uses that for a user
 *     cancellation, and the model would read it as "the user dropped this" and abandon work
 *     the user actually wants. It must NOT leak infra detail ("process restarted"/"crash")
 *     — that text can surface to the end user and reads as an outage.
 *   - `details` carries the operational marker for developers (logs/session inspection); it is
 *     never sent to the provider (`transform-messages` forwards only `content`).
 */
async function reconcileInterruptedToolCalls(session: Session): Promise<void> {
  const { messages } = await session.buildContext();

  // The leaf is the last assistant; only its gap can be repaired by appending (append-only log).
  let leafIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      leafIdx = i;
      break;
    }
  }
  if (leafIdx === -1) return; // no assistant turn yet
  const leafReparable = messages.slice(leafIdx + 1).every((m) => m.role === "toolResult");

  // Scan EVERY assistant turn-locally: a tool_use is paired only by the toolResults that
  // immediately follow it (up to the next non-toolResult). Turn-local windows are robust to
  // ids reused across turns; scanning every turn (not only the leaf) lets a mid-history gap be
  // surfaced rather than silently ignored.
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
      // The leaf's gap (last assistant, followed only by its own results) is repairable by
      // appending. Any earlier gap is mid-history: an append-only log cannot fix it.
      if (idx === leafIdx && leafReparable) toRepair.push({ id: block.id, name: block.name });
      else orphaned.push(block.id);
    }
  });

  if (orphaned.length > 0) {
    // Behind later history: a result appended at the end arrives too late. Surface, do not add an
    // orphan. Unreachable in the reconcile-on-open design; the guard is for forks/pre-fix sessions.
    console.warn(
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

/** In-process store (pi InMemorySessionRepo). Continuity lives and dies with the instance. */
export function inMemorySessionStore(): PiSessionStore {
  const repo = new InMemorySessionRepo();
  return {
    async openOrCreate(sessionId) {
      const existing = (await repo.list()).find((m) => m.id === sessionId);
      if (!existing) return repo.create({ id: sessionId });
      const session = await repo.open(existing);
      await reconcileInterruptedToolCalls(session);
      return session;
    },
  };
}

/**
 * Disk-backed store (pi JsonlSessionRepo under `dir`). The first persistent
 * backend: restart the process, conversations continue.
 * `cwd` is recorded in session metadata (pi associates sessions with a project
 * directory); defaults to process.cwd().
 */
export function jsonlSessionStore(options: { dir: string; cwd?: string }): PiSessionStore {
  const cwd = options.cwd ?? process.cwd();
  const repo = new JsonlSessionRepo({
    fs: new NodeExecutionEnv({ cwd }),
    sessionsRoot: options.dir,
  });
  return {
    async openOrCreate(sessionId) {
      // Caller-provided session ids land verbatim in jsonl FILENAMES — encode
      // anything unsafe (path separators, "..") before they reach the disk.
      const id = encodeSessionId(sessionId);
      // Scope the lookup to this store's cwd: pi groups sessions by project dir,
      // and two stores sharing a sessionsRoot must not open each other's sessions.
      const existing = (await repo.list({ cwd })).find((m) => m.id === id);
      if (!existing) return repo.create({ id, cwd });
      const session = await repo.open(existing);
      await reconcileInterruptedToolCalls(session);
      return session;
    },
  };
}

/** Injective filename-safe encoding: [A-Za-z0-9._-] verbatim ("s1" stays "s1"), the rest %-escaped ("%" itself included). */
function encodeSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}
