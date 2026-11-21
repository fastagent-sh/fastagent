/**
 * In-memory `DshEventStoreBackend` and Cordis `SessionPersistence` plugin bridge.
 * Enforces DSH's single-writer ownership and contiguous sequence contract while persisting
 * FastAgent's session metadata, message ledger, and attachments alongside the event log.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  SessionLogOffset,
} from "@deepseek-ai/dsh-session";
import {
  type SessionAccess,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  type SessionHandle,
  SessionHandleClosedError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
  SessionReadOnlyError,
} from "@deepseek-ai/dsh-session-persistence";
import type {
  DshEventStoreBackend,
  DshSessionEvent,
  DshSessionHandle,
  DshSessionHeader,
  DshSessionSnapshot,
  DshStoredAttachment,
  DshStoredMessage,
  DshStoredSession,
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
 * - detached snapshots on every read and write;
 * - durable metadata, message ledger, and attachments preserved across reopen.
 */
export class MemoryDshEventStore implements DshEventStoreBackend {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly writers = new Set<string>();
  private readonly metas = new Map<string, DshStoredSession>();
  private readonly messages = new Map<string, Map<string, DshStoredMessage>>();
  private readonly messagesByKey = new Map<string, Map<string, string>>();
  private readonly attachments = new Map<string, Map<string, DshStoredAttachment>>();

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

  async getSessionMeta(id: string): Promise<DshStoredSession | undefined> {
    const meta = this.metas.get(id);
    return meta === undefined ? undefined : clone(meta);
  }

  async putSessionMeta(session: DshStoredSession): Promise<void> {
    this.metas.set(session.id, clone(session));
  }

  async listSessionMetas(): Promise<readonly DshStoredSession[]> {
    return [...this.metas.values()].map((meta) => clone(meta));
  }

  async getMessage(sessionId: string, messageId: string): Promise<DshStoredMessage | undefined> {
    const message = this.messages.get(sessionId)?.get(messageId);
    return message === undefined ? undefined : clone(message);
  }

  async getMessageByKey(sessionId: string, idempotencyKey: string): Promise<DshStoredMessage | undefined> {
    const id = this.messagesByKey.get(sessionId)?.get(idempotencyKey);
    if (id === undefined) return undefined;
    return this.getMessage(sessionId, id);
  }

  async putMessage(message: DshStoredMessage): Promise<void> {
    let bySession = this.messages.get(message.sessionId);
    if (bySession === undefined) {
      bySession = new Map();
      this.messages.set(message.sessionId, bySession);
    }
    bySession.set(message.id, clone(message));
    if (message.idempotencyKey !== undefined) {
      let keys = this.messagesByKey.get(message.sessionId);
      if (keys === undefined) {
        keys = new Map();
        this.messagesByKey.set(message.sessionId, keys);
      }
      keys.set(message.idempotencyKey, message.id);
    }
  }

  async listMessages(sessionId?: string): Promise<readonly DshStoredMessage[]> {
    if (sessionId !== undefined) {
      return [...(this.messages.get(sessionId)?.values() ?? [])].map((message) => clone(message));
    }
    const all: DshStoredMessage[] = [];
    for (const map of this.messages.values()) {
      for (const message of map.values()) all.push(clone(message));
    }
    return all;
  }

  async putAttachment(attachment: DshStoredAttachment): Promise<void> {
    let bySession = this.attachments.get(attachment.sessionId);
    if (bySession === undefined) {
      bySession = new Map();
      this.attachments.set(attachment.sessionId, bySession);
    }
    bySession.set(attachment.ref, {
      ...attachment,
      data: new Uint8Array(attachment.data),
    });
  }

  async getAttachment(sessionId: string, ref: string): Promise<DshStoredAttachment | undefined> {
    const found = this.attachments.get(sessionId)?.get(ref);
    if (found === undefined) return undefined;
    return {
      ...found,
      data: new Uint8Array(found.data),
    };
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
        if (length !== undefined && (!Number.isInteger(length) || length < 0)) {
          throw new Error(`DSH read length must be a non-negative integer, got ${String(length)}`);
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

function toDshSessionHeader(header: DshSessionHeader): SessionHeader {
  return {
    ...(header as unknown as SessionHeader),
    version: SESSION_FORMAT_VERSION,
  };
}

function mapPersistenceError(sessionId: SessionId, operation: string, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("already exists")) return new SessionAlreadyExistsError(sessionId);
  if (message.includes("already owned")) return new SessionAlreadyOwnedError(sessionId);
  if (message.includes("does not exist")) return new SessionPersistenceNotFoundError(sessionId);
  if (message.includes("is closed")) return new SessionHandleClosedError(sessionId, operation);
  if (message.includes("is read-only")) return new SessionReadOnlyError(sessionId, operation);
  return error;
}

function wrapHandle(id: SessionId, inner: DshSessionHandle, onStorageError?: (error: unknown) => void): SessionHandle {
  const wrapped: SessionHandle = {
    id,
    header: toDshSessionHeader(inner.header),
    inheritedEventCount: SessionLogOffset(inner.inheritedEventCount),
    access: inner.access,
    async read(offset?: number, length?: number) {
      try {
        const result = await inner.read(offset, length);
        return {
          events: result.events as unknown as readonly SessionEvent[],
          eventState: "detached" as const,
        };
      } catch (error) {
        onStorageError?.(error);
        throw mapPersistenceError(id, "read", error);
      }
    },
    async append(events: readonly SessionEvent[]) {
      try {
        await inner.append(events as unknown as readonly DshSessionEvent[]);
      } catch (error) {
        onStorageError?.(error);
        throw mapPersistenceError(id, "append", error);
      }
    },
    async flush() {
      try {
        await inner.flush();
      } catch (error) {
        onStorageError?.(error);
        throw mapPersistenceError(id, "flush", error);
      }
    },
    close: () => inner.close(),
    async [Symbol.asyncDispose]() {
      await inner.close();
    },
  };
  return wrapped;
}

/**
 * Create a Cordis `SessionPersistence` plugin class backed by `backend`.
 * Reports storage failures through `onStorageError` so active watchers receive `stream_error`.
 */
export function createDshPersistencePlugin(
  backend: DshEventStoreBackend,
  onStorageError?: (sessionId: string | undefined, error: unknown) => void,
): new (
  ctx: Context,
) => SessionPersistence {
  return class BackendSessionPersistence extends SessionPersistence {
    private readonly activeWriters = new Map<
      string,
      { handle: DshSessionHandle; nextSeq: number; chain: Promise<void> }
    >();

    constructor(ctx: Context) {
      super(ctx);
      ctx.on("session/event", (session, event) => {
        const entry = this.activeWriters.get(session.id);
        if (entry === undefined || entry.handle.closed) return;
        if (event.seq < entry.nextSeq) return;
        entry.nextSeq = event.seq + 1;
        entry.chain = entry.chain.then(async () => {
          if (entry.handle.closed) return;
          try {
            await entry.handle.append([event as unknown as DshSessionEvent]);
          } catch (error) {
            onStorageError?.(session.id, error);
            throw error;
          }
        });
        // Prevent unhandled rejection; callers observe failures on session/flush or via onStorageError.
        entry.chain.catch(() => {});
      });
      ctx.on("session/flush", async (session) => {
        const entry = this.activeWriters.get(session.id);
        if (entry === undefined || entry.handle.closed) return;
        await entry.chain;
        try {
          await entry.handle.flush();
        } catch (error) {
          onStorageError?.(session.id, error);
          throw error;
        }
      });
    }

    private trackWriter(id: SessionId, raw: DshSessionHandle, initialSeq: number): SessionHandle {
      const activeWriters = this.activeWriters;
      const state = { handle: raw, nextSeq: initialSeq, chain: Promise.resolve() };
      activeWriters.set(id, state);
      const wrapped = wrapHandle(id, raw, (err) => onStorageError?.(id, err));
      const baseAppend = wrapped.append.bind(wrapped);
      const baseFlush = wrapped.flush.bind(wrapped);
      const baseClose = wrapped.close.bind(wrapped);
      return {
        ...wrapped,
        async append(events: readonly SessionEvent[]) {
          await state.chain.catch(() => {});
          if (events.length === 0) return;
          const last = events.at(-1);
          if (last !== undefined && last.seq + 1 > state.nextSeq) {
            state.nextSeq = last.seq + 1;
          }
          await baseAppend(events);
        },
        async flush() {
          await state.chain;
          await baseFlush();
        },
        async close() {
          await state.chain.catch(() => {});
          activeWriters.delete(id);
          await baseClose();
        },
        async [Symbol.asyncDispose]() {
          await state.chain.catch(() => {});
          activeWriters.delete(id);
          await baseClose();
        },
      };
    }

    async create(header: SessionHeader, options?: { readonly inheritedEventCount?: number }): Promise<SessionHandle> {
      try {
        const handle = await backend.create(header as unknown as DshSessionHeader, options);
        return this.trackWriter(header.id, handle, 0);
      } catch (error) {
        onStorageError?.(header.id, error);
        throw mapPersistenceError(header.id, "create", error);
      }
    }

    async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
      try {
        const handle = await backend.open(id, access);
        if (access === "write") {
          const snap = await backend.stat(id);
          return this.trackWriter(id, handle, snap?.eventCount ?? 0);
        }
        return wrapHandle(id, handle, (err) => onStorageError?.(id, err));
      } catch (error) {
        onStorageError?.(id, error);
        throw mapPersistenceError(id, "open", error);
      }
    }

    async flush(): Promise<void> {
      try {
        await backend.flush();
      } catch (error) {
        onStorageError?.(undefined, error);
        throw error;
      }
    }

    async stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
      try {
        const snapshot = await backend.stat(id);
        if (snapshot === undefined) return undefined;
        return {
          header: toDshSessionHeader(snapshot.header),
          formatStatus: "current",
          revision: SessionPersistenceRevision(snapshot.revision),
          eventCount: snapshot.eventCount,
        };
      } catch (error) {
        onStorageError?.(id, error);
        throw error;
      }
    }

    async list(): Promise<readonly SessionPersistenceSnapshot[]> {
      try {
        const snapshots = await backend.list();
        return snapshots.map((snapshot) => ({
          header: toDshSessionHeader(snapshot.header),
          formatStatus: "current",
          revision: SessionPersistenceRevision(snapshot.revision),
          eventCount: snapshot.eventCount,
        }));
      } catch (error) {
        onStorageError?.(undefined, error);
        throw error;
      }
    }
  };
}
