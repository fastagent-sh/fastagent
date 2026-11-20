/**
 * In-memory `DshEventStoreBackend` implementing the exact single-writer and contiguous-sequence contract of
 * `@deepseek-ai/dsh-session-persistence`. Serves as the reference double for unit tests and the contract template
 * for future SQLite / PostgreSQL backends.
 */
import type {
  DshEventStoreBackend,
  DshSessionEvent,
  DshSessionHandle,
  DshSessionHeader,
  DshSessionSnapshot,
} from "./types.ts";

interface StoredSession {
  readonly header: DshSessionHeader;
  readonly inheritedEventCount: number;
  readonly events: DshSessionEvent[];
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-memory `DshEventStoreBackend` enforcing:
 * - unique session creation;
 * - single-writer ownership per session (concurrent `read` handles are allowed);
 * - contiguous append validation starting at `events.length`;
 * - detached snapshots on every read and write.
 */
export class MemoryDshEventStore implements DshEventStoreBackend {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly writers = new Set<string>();

  async create(
    header: DshSessionHeader,
    options: { readonly inheritedEventCount?: number } = {},
  ): Promise<DshSessionHandle> {
    if (this.sessions.has(header.id)) {
      throw new Error(`DSH session "${header.id}" already exists`);
    }
    const inheritedEventCount = options.inheritedEventCount ?? 0;
    if (header.isSeeded && inheritedEventCount <= 0) {
      throw new Error(`DSH seeded session "${header.id}" requires inheritedEventCount > 0`);
    }
    if (!header.isSeeded && inheritedEventCount !== 0) {
      throw new Error(`DSH unseeded session "${header.id}" must have inheritedEventCount = 0`);
    }
    const record: StoredSession = {
      header: clone(header),
      inheritedEventCount,
      events: [],
    };
    this.sessions.set(header.id, record);
    this.writers.add(header.id);
    return this.makeHandle(header.id, "write", record);
  }

  async open(id: string, access: "read" | "write"): Promise<DshSessionHandle> {
    const record = this.sessions.get(id);
    if (record === undefined) {
      throw new Error(`DSH session "${id}" does not exist`);
    }
    if (access === "write") {
      if (this.writers.has(id)) {
        throw new Error(`DSH session "${id}" is already owned by another writer`);
      }
      this.writers.add(id);
    }
    return this.makeHandle(id, access, record);
  }

  async flush(): Promise<void> {}

  async stat(id: string): Promise<DshSessionSnapshot | undefined> {
    const record = this.sessions.get(id);
    if (record === undefined) return undefined;
    return {
      header: clone(record.header),
      revision: String(record.events.length),
      eventCount: record.events.length,
    };
  }

  async list(): Promise<readonly DshSessionSnapshot[]> {
    return [...this.sessions.values()].map((record) => ({
      header: clone(record.header),
      revision: String(record.events.length),
      eventCount: record.events.length,
    }));
  }

  private makeHandle(id: string, access: "read" | "write", record: StoredSession): DshSessionHandle {
    let closed = false;
    const assertOpen = () => {
      if (closed) throw new Error(`DSH session handle for "${id}" is closed`);
    };
    const handle: DshSessionHandle = {
      id,
      access,
      header: clone(record.header),
      inheritedEventCount: record.inheritedEventCount,
      get closed() {
        return closed;
      },
      async read(offset = 0, length?: number) {
        assertOpen();
        if (!Number.isInteger(offset) || offset < 0) {
          throw new Error(`DSH read offset must be a non-negative integer, got ${String(offset)}`);
        }
        const slice = length === undefined ? record.events.slice(offset) : record.events.slice(offset, offset + length);
        return { events: clone(slice), eventState: "detached" as const };
      },
      async append(events) {
        assertOpen();
        if (access !== "write") {
          throw new Error(`DSH session handle for "${id}" is read-only`);
        }
        let expectedSeq = record.events.length;
        for (const event of events) {
          if (event.seq !== expectedSeq) {
            throw new Error(`DSH session "${id}" expected contiguous seq ${expectedSeq}, got ${String(event.seq)}`);
          }
          expectedSeq += 1;
        }
        for (const event of events) {
          record.events.push(clone(event));
        }
      },
      async flush() {
        assertOpen();
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (access === "write") this.writers.delete(id);
      },
      async [Symbol.asyncDispose]() {
        await handle.close();
      },
    };
    return handle;
  }
}
