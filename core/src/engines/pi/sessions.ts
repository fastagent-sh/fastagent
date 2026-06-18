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
 * session-log port (see docs/session.md) would be a separate abstraction, justified
 * only once a second engine provides the real requirement.
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
 * transcript validity, it does not promise the interrupted tool ran exactly once. Dangling
 * calls are assumed to belong to the leaf turn (the only turn a crash can interrupt), so the
 * appended results land at the leaf, immediately after that assistant message.
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
  const settled = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult") settled.add(m.toolCallId);
  }
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const block of m.content) {
      if (block.type !== "toolCall" || settled.has(block.id)) continue;
      const result: AgentMessage = {
        role: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
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
      settled.add(block.id); // a malformed message could repeat an id; never append twice
    }
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
  return id.replace(
    /[^A-Za-z0-9._-]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}
