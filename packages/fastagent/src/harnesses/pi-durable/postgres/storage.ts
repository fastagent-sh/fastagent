/**
 * pi-durable's Storage on PostgreSQL: its SQLite storage (MIT, earendil-works/pi) ported, every row keyed by the
 * instance, with single-writer lease fencing via `durable_leases` and `durable_metadata.owner`.
 */
import { Unavailable } from "../../../unavailable.ts";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { apply } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  type CommitResult,
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  type JsonObject,
  type Page,
  type Seq,
  type Storage,
  StorageRequestError,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { log } from "../../../log.ts";
import {
  CommitState,
  type DocumentAction,
  PendingWrites,
  addressParts,
  claimOf,
  encodeIndexedString,
  isCurrentOnly,
  parseJson,
  prepareDocumentActions,
  scopeColumns,
} from "./commit.ts";
import {
  type PgDatabase,
  type PgExecutor,
  type PostgresDatabase,
  type PostgresOptions,
  type SharedPostgresHandle,
  describeDatabase,
  isTransientPgError,
  openPgDatabase,
  sharedHandleOf,
} from "../../../postgres.ts";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_LEASE_WAIT_MS,
  InstanceHeld,
  type PgInstanceLease,
  type PgLeaseHandoff,
  acquirePgInstanceLease,
  isPgConflict,
} from "../../../postgres-kit.ts";
import { migrate } from "./schema.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };
type Order = "ascending" | "descending";

interface LeaseOptions {
  leaseMs: number;
  waitMs: number;
}

const DEFAULT_LEASE: LeaseOptions = { leaseMs: DEFAULT_LEASE_MS, waitMs: DEFAULT_LEASE_WAIT_MS };

function scanStart(requested: Order | undefined, cursor: Cursor | undefined, fallback: Order) {
  if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
    throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
  }
  if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
  const { after, order: stored } = cursor;
  if (typeof after !== "number" || !Number.isSafeInteger(after))
    throw new StorageRequestError("Invalid storage cursor");
  if (stored !== undefined && stored !== "ascending" && stored !== "descending") {
    throw new StorageRequestError("Invalid storage cursor");
  }
  const order: Order = stored ?? fallback;
  if (requested !== undefined && requested !== order) {
    throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
  }
  return { order, after };
}

function page<T extends { readonly id: number }>(
  values: T[],
  limit: number,
  order: Order = "ascending",
): Page<T, Cursor> {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  return { items, next: { after: (items.at(-1) as T).id, order } };
}

function cursorId(cursor: Cursor | undefined): number | undefined {
  const after = cursor?.after;
  if (after === undefined) return undefined;
  if (typeof after !== "number" || !Number.isSafeInteger(after))
    throw new StorageRequestError("Invalid storage cursor");
  return after;
}

const isAliveAt = (record: DocumentRecord, at: DocumentPoint) =>
  at === "current"
    ? record.retiredAt === undefined
    : record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);

export { InstanceHeld };

export interface OpenOptions {
  holders?: string;
  agent?: string;
  lease?: LeaseOptions;
  pool?: SharedPostgresHandle;
  handoff?: PgLeaseHandoff;
  onLost?: (error: Error) => void;
}

export class PostgresStorage implements Storage {
  private closed = false;
  private closing: Promise<void> | undefined;
  private admittedReads = 0;
  private readsDrained: (() => void) | undefined;
  private readonly db: PgDatabase;
  private readonly instance: string;
  private nextId: number;
  private readonly lease: PgInstanceLease<number>;

  private constructor(db: PgDatabase, instance: string, lease: PgInstanceLease<number>) {
    this.db = db;
    this.instance = instance;
    this.nextId = lease.taken;
    this.lease = lease;
  }

  static async open(db: PgDatabase, instance: string, options: OpenOptions = {}): Promise<PostgresStorage> {
    const leaseOpts = options.lease ?? DEFAULT_LEASE;
    await db.query(
      "INSERT INTO durable_metadata (instance, next_id, next_seq) VALUES ($1, 2, 1) ON CONFLICT (instance) DO NOTHING",
      [instance],
    );
    const lease = await acquirePgInstanceLease<number>(db, {
      table: "durable_leases",
      instance,
      leaseMs: leaseOpts.leaseMs,
      waitMs: leaseOpts.waitMs,
      ...(options.pool === undefined ? {} : { pool: options.pool }),
      ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
      ...(options.holders === undefined ? {} : { holders: options.holders }),
      ...(options.onLost === undefined ? {} : { onLost: options.onLost }),
      onTake: async (tx, owner) => {
        const [metadata] = await tx.query<{ next_id: number; agent: string | null }>(
          "UPDATE durable_metadata SET owner = $2, agent = COALESCE(agent, $3) WHERE instance = $1 RETURNING next_id, agent",
          [instance, owner, options.agent ?? null],
        );
        if (options.agent !== undefined && metadata?.agent !== options.agent) {
          throw new Error(
            `the instance "${instance}" belongs to the agent "${metadata?.agent}", not "${options.agent}": ` +
              "give this one another name (FASTAGENT_NAME)",
          );
        }
        if (metadata === undefined) throw new Error(`the instance "${instance}" has no metadata row`);
        return metadata.next_id;
      },
    });
    return new PostgresStorage(db, instance, lease);
  }

  async commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
    _context: Context,
  ): Promise<CommitResult> {
    this.assertOpen();
    if (this.lease.lost !== undefined) throw this.lease.lost;
    const seqs: Seq[] = [];
    let refused: { error: unknown } | undefined;
    let candidateNextId = this.nextId;
    const pending = new PendingWrites();

    await this.db
      .transaction(async (tx) => {
        const [metadata] = await tx.query<{ next_id: number; next_seq: number }>(
          "SELECT next_id, next_seq FROM durable_metadata WHERE instance = $1",
          [this.instance],
        );
        if (metadata === undefined) throw new Error(`the instance "${this.instance}" has no metadata row`);
        let next = metadata.next_seq;
        const state = await CommitState.read(tx, this.instance, batches);
        for (const writes of batches) {
          const checked = await this.checkBatch(tx, state, pending, writes);
          if ("refused" in checked) {
            refused = { error: checked.refused };
            break;
          }
          const seq = next++ as Seq;
          state.apply(writes, checked.actions, seq);
          pending.add(writes, checked.actions, seq, state);
          seqs.push(seq);
          candidateNextId = Math.max(candidateNextId, this.candidateNextId(writes));
        }
        await pending.flush(tx, this.instance);
        if (seqs.length === 0) return;
        const [fenced] = await tx.query(
          "UPDATE durable_metadata SET next_id = $2, next_seq = $3 WHERE instance = $1 AND owner = $4 RETURNING instance",
          [this.instance, Math.max(metadata.next_id, candidateNextId), next, this.lease.owner],
        );
        if (fenced === undefined) throw this.lease.lose();
      })
      .catch((error: unknown) => {
        if (isPgConflict(error)) throw this.lease.lose();
        throw error;
      });

    this.nextId = Math.max(this.nextId, candidateNextId);
    for (const [index, seq] of seqs.entries()) receive(index, seq);
    await this.collectGarbage(pending.garbage());
    return refused === undefined
      ? { kind: "stored", stored: seqs.length }
      : { kind: "refused", stored: seqs.length, refused: refused.error };
  }

  private async collectGarbage(garbage: ReadonlyMap<number, number>): Promise<void> {
    if (garbage.size === 0) return;
    try {
      await this.db.query(
        `DELETE FROM durable_document_revisions WHERE instance = $1 AND (document_id, seq) IN (
          SELECT r.document_id, r.seq FROM durable_document_revisions AS r
            JOIN unnest($2::bigint[], $3::bigint[]) AS g(id, below) ON r.document_id = g.id AND r.seq < g.below
            WHERE r.instance = $1)`,
        [this.instance, [...garbage.keys()], [...garbage.values()]],
      );
    } catch (error) {
      log.warn(`[fastagent] collecting unreadable revisions of "${this.instance}" failed: ${String(error)}`);
    }
  }

  private async checkBatch(
    tx: PgExecutor,
    state: CommitState,
    pending: PendingWrites,
    writes: readonly StorageWrite[],
  ): Promise<{ actions: Map<number, DocumentAction> } | { refused: unknown }> {
    let actions: Map<number, DocumentAction>;
    try {
      actions = prepareDocumentActions(writes);
      state.check(writes, actions);
    } catch (error) {
      return { refused: error };
    }
    if (![...actions.values()].some((action) => action.copy !== undefined)) return { actions };
    await pending.flush(tx, this.instance);
    let databaseFailed = false;
    const watched: PgExecutor = {
      query: <T extends object>(text: string, params?: readonly unknown[]) =>
        tx.query<T>(text, params).catch((error: unknown) => {
          databaseFailed = true;
          throw error;
        }),
    };
    try {
      await this.resolveCopies(watched, actions);
    } catch (error) {
      if (databaseFailed) throw error;
      return { refused: error };
    }
    return { actions };
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    this.assertOpen();
    if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
    return this.nextId++ as I;
  }

  async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    this.assertOpen();
    return this.readConversation(id);
  }

  private async scanRecords<T extends { readonly id: number }>(
    table: string,
    start: { order: Order; after: number | undefined },
    filters: readonly (readonly [column: string, value: unknown])[],
    limit: number,
  ): Promise<Page<T, Cursor>> {
    const ascending = start.order === "ascending";
    const params: unknown[] = [this.instance, start.after ?? (ascending ? -1 : Number.MAX_SAFE_INTEGER)];
    const clauses = ["instance = $1", ascending ? "id > $2" : "id < $2"];
    for (const [column, value] of filters) {
      params.push(value);
      clauses.push(`${column} = $${params.length}`);
    }
    params.push(limit + 1);
    const values = await this.select<T>(
      this.db,
      `SELECT record FROM ${table} WHERE ${clauses.join(" AND ")}
        ORDER BY id ${ascending ? "ASC" : "DESC"} LIMIT $${params.length}`,
      params,
    );
    return page(values, limit, start.order);
  }

  private async select<T>(executor: PgExecutor, sql: string, params: readonly unknown[]): Promise<T[]> {
    const rows = await executor.query<{ record: string }>(sql, params);
    return rows.map((row) => parseJson<T>(row.record));
  }

  async scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    this.assertOpen();
    const filters: [string, unknown][] = [];
    if (query.ownerConversationId !== undefined) filters.push(["owner_conversation_id", query.ownerConversationId]);
    if (query.ownerTaskId !== undefined) filters.push(["owner_task_id", query.ownerTaskId]);
    return this.scanRecords("durable_conversations", scanStart(query.order, cursor, "ascending"), filters, limit);
  }

  entry(id: EntryId, context: Context): Promise<StoredEntry | undefined>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<StoredEntry | undefined>;
  entry(
    idOrConversationId: EntryId | ConversationId,
    idOrContext: EntryId | Context,
    context?: Context,
  ): Promise<StoredEntry | undefined> {
    return this.admitRead(() => this.readEntry(idOrConversationId, idOrContext, context));
  }

  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.admitRead(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId));
  }

  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.admitRead(() => this.readEntries(query, limit, cursor));
  }

  private async readEntry(
    idOrConversationId: number,
    idOrContext: number | Context,
    context: Context | undefined,
  ): Promise<StoredEntry | undefined> {
    const id = context === undefined ? idOrConversationId : typeof idOrContext === "number" ? idOrContext : undefined;
    if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
    let conversation: ConversationRecord | undefined;
    if (context !== undefined) {
      conversation = await this.readConversation(idOrConversationId as ConversationId);
      if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${idOrConversationId}`);
    }
    const [row] = await this.db.query<{ record: string; commit_seq: number }>(
      "SELECT record, commit_seq FROM durable_entries WHERE instance = $1 AND id = $2",
      [this.instance, id],
    );
    if (row === undefined) return undefined;
    const entry = parseJson<EntryRecord>(row.record);
    if (conversation !== undefined) {
      let upperEntryId = Number.POSITIVE_INFINITY;
      while (conversation.id !== entry.conversationId) {
        if (conversation.parent === undefined) return undefined;
        upperEntryId = Math.min(upperEntryId, conversation.parent.at);
        conversation = (await this.readConversation(conversation.parent.conversationId)) as ConversationRecord;
      }
      if (entry.id > upperEntryId) return undefined;
    }
    return { entry, commitSeq: row.commit_seq as Seq };
  }

  private async readLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    let conversation = await this.readConversation(conversationId);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
    let upper: number | undefined = atOrBeforeEntryId;
    while (true) {
      const [marker] = await this.select<EntryRecord & { readonly head: EntryId }>(
        this.db,
        `SELECT record FROM durable_entries WHERE instance = $1 AND conversation_id = $2
          AND head IS NOT NULL AND id <= $3 ORDER BY id DESC LIMIT 1`,
        [this.instance, conversation.id, upper ?? Number.MAX_SAFE_INTEGER],
      );
      if (marker !== undefined) return marker;
      if (conversation.parent === undefined) return undefined;
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      conversation = (await this.readConversation(conversation.parent.conversationId)) as ConversationRecord;
    }
  }

  private async entriesOf(
    conversationId: number,
    lower: number | undefined,
    upper: number | undefined,
    direction: "ASC" | "DESC",
    limit: number,
  ): Promise<EntryRecord[]> {
    return this.select<EntryRecord>(
      this.db,
      `SELECT record FROM durable_entries WHERE instance = $1 AND conversation_id = $2
        AND id >= $3 AND id <= $4 ORDER BY id ${direction} LIMIT $5`,
      [this.instance, conversationId, lower ?? 0, upper ?? Number.MAX_SAFE_INTEGER, limit],
    );
  }

  private async readEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined) {
    const { order, after } = scanStart(query.order, cursor, "descending");
    if (order === "ascending") return this.readEntriesAscending(query, limit, after);
    let conversation = await this.readConversation(query.conversationId);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
    let upper: number | undefined = query.maxEntryId;
    if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
    const values: EntryRecord[] = [];
    while (true) {
      values.push(
        ...(await this.entriesOf(conversation.id, query.minEntryId, upper, "DESC", limit + 1 - values.length)),
      );
      if (values.length > limit || conversation.parent === undefined) break;
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      if (query.minEntryId !== undefined && upper < query.minEntryId) break;
      conversation = (await this.readConversation(conversation.parent.conversationId)) as ConversationRecord;
    }
    return page(values, limit, "descending");
  }

  private async readEntriesAscending(query: EntryQuery, limit: number, after: number | undefined) {
    const segments: { conversationId: number; upper: number | undefined }[] = [];
    let conversation = await this.readConversation(query.conversationId);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
    let upper: number | undefined = query.maxEntryId;
    while (true) {
      segments.push({ conversationId: conversation.id, upper });
      if (conversation.parent === undefined) break;
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      if (query.minEntryId !== undefined && upper < query.minEntryId) break;
      conversation = (await this.readConversation(conversation.parent.conversationId)) as ConversationRecord;
    }
    let lower: number | undefined = query.minEntryId;
    if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
    const values: EntryRecord[] = [];
    for (const segment of segments.reverse()) {
      values.push(
        ...(await this.entriesOf(segment.conversationId, lower, segment.upper, "ASC", limit + 1 - values.length)),
      );
      if (values.length > limit) break;
    }
    return page(values, limit, "ascending");
  }

  async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
    this.assertOpen();
    const [record] = await this.select<StoredTask>(
      this.db,
      "SELECT record FROM durable_tasks WHERE instance = $1 AND id = $2",
      [this.instance, id],
    );
    return record;
  }

  async scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<StoredTask, Cursor>> {
    this.assertOpen();
    const filters: [string, unknown][] = [];
    if (query.conversationId !== undefined) filters.push(["conversation_id", query.conversationId]);
    if (query.kind !== undefined) filters.push(["kind", encodeIndexedString(query.kind)]);
    if (query.status !== undefined) filters.push(["status", query.status]);
    if (query.abortRequested !== undefined) filters.push(["abort_requested", query.abortRequested ? 1 : 0]);
    if (query.background !== undefined) filters.push(["background", query.background ? 1 : 0]);
    return this.scanRecords("durable_tasks", scanStart(query.order, cursor, "ascending"), filters, limit);
  }

  async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    this.assertOpen();
    const [record] = await this.select<SubmissionRecord>(
      this.db,
      "SELECT record FROM durable_submissions WHERE instance = $1 AND id = $2",
      [this.instance, id],
    );
    return record;
  }

  async scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    this.assertOpen();
    const filters: [string, unknown][] = [];
    if (query.conversationId !== undefined) filters.push(["conversation_id", query.conversationId]);
    if (query.status !== undefined) filters.push(["status", query.status]);
    return this.scanRecords("durable_submissions", scanStart(query.order, cursor, "ascending"), filters, limit);
  }

  async submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context: Context,
  ): Promise<SubmissionRecord | undefined> {
    this.assertOpen();
    const [record] = await this.select<SubmissionRecord>(
      this.db,
      "SELECT record FROM durable_submissions WHERE instance = $1 AND conversation_id = $2 AND request_id = $3",
      [this.instance, conversationId, encodeIndexedString(requestId)],
    );
    return record;
  }

  async findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    _context: Context,
  ): Promise<DocumentRecord | undefined> {
    this.assertOpen();
    const parts = addressParts(address);
    const params: unknown[] = [this.instance, parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
    if (at !== "current") params.push(at);
    const alive =
      at === "current" ? "retired_at IS NULL" : "created_at <= $7 AND (retired_at IS NULL OR retired_at > $7)";
    const [record] = await this.select<DocumentRecord>(
      this.db,
      `SELECT record FROM durable_documents WHERE instance = $1 AND kind = $2 AND scope_kind = $3
        AND owner_id = $4 AND family = $5 AND key_value = $6 AND ${alive} ORDER BY created_at DESC LIMIT 1`,
      params,
    );
    return record;
  }

  async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
    this.assertOpen();
    return this.db.transaction((tx) => this.materializeDocument(tx, id, at));
  }

  async scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    this.assertOpen();
    const scope = scopeColumns(query.scope);
    const params: unknown[] = [this.instance, scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1];
    const clauses = ["instance = $1", "scope_kind = $2", "owner_id = $3", "id > $4"];
    if (query.kind !== undefined) {
      params.push(encodeIndexedString(query.kind));
      clauses.push(`kind = $${params.length}`);
    }
    if (query.at === "current") {
      clauses.push("retired_at IS NULL");
    } else {
      params.push(query.at);
      clauses.push(`created_at <= $${params.length}`, `(retired_at IS NULL OR retired_at > $${params.length})`);
    }
    params.push(limit + 1);
    const records = await this.select<DocumentRecord>(
      this.db,
      `SELECT record FROM durable_documents WHERE ${clauses.join(" AND ")}
        ORDER BY id LIMIT $${params.length}`,
      params,
    );
    return page(records, limit);
  }

  close(_context: Context): Promise<void> {
    if (this.closing === undefined) {
      this.closed = true;
      this.closing = (async () => {
        if (this.admittedReads > 0) await new Promise<void>((resolve) => (this.readsDrained = resolve));
        try {
          await this.lease.release();
        } finally {
          await this.db.close();
        }
      })();
    }
    return this.closing;
  }

  private async admitRead<T>(read: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.admittedReads++;
    try {
      return await read();
    } finally {
      if (--this.admittedReads === 0) this.readsDrained?.();
    }
  }

  private async readConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
    const [record] = await this.select<ConversationRecord>(
      this.db,
      "SELECT record FROM durable_conversations WHERE instance = $1 AND id = $2",
      [this.instance, id],
    );
    return record;
  }

  private async materializeDocument(
    tx: PgExecutor,
    id: DocumentId,
    at: DocumentPoint,
  ): Promise<StoredDocument | undefined> {
    const [record] = await this.select<DocumentRecord>(
      tx,
      "SELECT record FROM durable_documents WHERE instance = $1 AND id = $2",
      [this.instance, id],
    );
    if (record === undefined) return undefined;
    if (at !== "current" && isCurrentOnly(record)) {
      throw new StorageRequestError(`Document ${id} does not retain historical content`);
    }
    if (!isAliveAt(record, at)) return undefined;
    const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
    type Revision = { seq: number; kind: string; version: number; content: string };
    const [base] = await tx.query<Revision>(
      `SELECT seq, kind, version, content FROM durable_document_revisions
        WHERE instance = $1 AND document_id = $2 AND kind = 'base' AND seq <= $3 ORDER BY seq DESC LIMIT 1`,
      [this.instance, id, upper],
    );
    if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
    const tail = await tx.query<Revision>(
      `SELECT seq, kind, version, content FROM durable_document_revisions
        WHERE instance = $1 AND document_id = $2 AND seq > $3 AND seq <= $4 ORDER BY seq`,
      [this.instance, id, base.seq, upper],
    );
    let value = parseJson<JsonObject>(base.content);
    for (const revision of tail) {
      if (revision.kind !== "delta" || revision.version !== base.version) {
        throw new Error(`Document ${id} crosses a stored version boundary without a base`);
      }
      value = apply(value, parseJson(revision.content)) as JsonObject;
    }
    return { record, version: base.version, value, deltasSinceBase: tail.length };
  }

  private candidateNextId(writes: readonly StorageWrite[]): number {
    let nextId = this.nextId;
    for (const write of writes) {
      const id = claimOf(write)?.id;
      if (id !== undefined) nextId = Math.max(nextId, id + 1);
    }
    return nextId;
  }

  private async resolveCopies(tx: PgExecutor, actions: Map<number, DocumentAction>): Promise<void> {
    for (const [id, action] of actions) {
      if (action.copy === undefined) continue;
      try {
        const stored = await this.materializeDocument(tx, action.copy.id as DocumentId, action.copy.at);
        if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
        const create = action.create as NonNullable<DocumentAction["create"]>;
        if (
          stored.record.scope.kind !== "conversation" ||
          create.scope.kind !== "conversation" ||
          stored.record.kind !== create.kind ||
          stored.record.key !== create.key ||
          stored.record.history !== create.history ||
          stored.record.fork !== create.fork
        ) {
          throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
        }
        action.content = { kind: "base", version: stored.version, value: stored.value };
      } catch (error) {
        throw new Error(`Document copy ${id} was rejected`, { cause: error });
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("PostgresStorage is closed");
  }
}

export async function openPostgresStorage(
  database: string | PostgresDatabase,
  instance: string,
  options: Omit<OpenOptions, "lease" | "pool"> & PostgresOptions = {},
): Promise<PostgresStorage> {
  const url = typeof database === "string" ? database : database.url;
  const shared = typeof database === "string" ? undefined : sharedHandleOf(database);
  const password = options.password ?? (typeof database === "string" ? undefined : database.password);
  const { password: _p, ...openOpts } = options;

  if (shared !== undefined) {
    shared.assertOpen();
    try {
      await shared.ensureMigrated("pi-durable", (db) => migrate(db));
      shared.assertOpen();
      const storage = await PostgresStorage.open(shared.borrowed, instance, { ...openOpts, pool: shared });
      if (shared.isClosed()) {
        await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
        shared.assertOpen();
      }
      return storage;
    } catch (error) {
      if (error instanceof InstanceHeld || shared.isClosed()) throw error;
      const failed = isTransientPgError(error) ? Unavailable : Error;
      throw new failed(`the database ${describeDatabase(url)}: ${(error as Error).message}`, { cause: error });
    }
  }

  const db = openPgDatabase(url, password === undefined ? {} : { password });
  try {
    await migrate(db);
    return await PostgresStorage.open(db, instance, openOpts);
  } catch (error) {
    await db
      .close()
      .catch((cleanup: unknown) => log.warn(`[fastagent] closing the database failed: ${String(cleanup)}`));
    if (error instanceof InstanceHeld) throw error;
    const failed = isTransientPgError(error) ? Unavailable : Error;
    throw new failed(`the database ${describeDatabase(url)}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}
