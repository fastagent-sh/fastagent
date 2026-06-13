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
import type { Session } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/** What fastagent needs from a session backend: open-or-create by opaque id. */
export interface PiSessionStore {
  openOrCreate(sessionId: string): Promise<Session>;
}

/** In-process store (pi InMemorySessionRepo). Continuity lives and dies with the instance. */
export function inMemorySessionStore(): PiSessionStore {
  const repo = new InMemorySessionRepo();
  return {
    async openOrCreate(sessionId) {
      const existing = (await repo.list()).find((m) => m.id === sessionId);
      return existing ? repo.open(existing) : repo.create({ id: sessionId });
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
      return existing ? repo.open(existing) : repo.create({ id, cwd });
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
