/**
 * pi-durable's Storage on PostgreSQL: its SQLite storage (MIT, earendil-works/pi) ported, every row keyed by the
 * instance, so the instance's sessions live in a database instead of a file beside it.
 *
 * One process writes an instance at a time, as SQLite's exclusive lock gives a file: a process holds the instance's
 * lease (`durable_leases`), renews it while open and releases it at close; a holder that dies leaves it for at most
 * `LEASE_MS`. The lease alone cannot stop a holder that stalled past it, so the writer's token is also in the metadata
 * row, which every commit writes: a takeover writes that row too, so the stalled holder's next commit finds another
 * token, or conflicts with the takeover, and fails the Session instead of writing beside the new holder. The lease
 * lives in its own row so renewing it never conflicts with a commit.
 *
 * Fencing the storage does not stop a tool already running. So a holder that cannot renew gives the instance up itself
 * before its lease can lapse (`GIVE_UP_AFTER`), and says so (`onLost`), for its runs to be stopped before a successor
 * may resume them.
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
  batchCost,
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
  type PostgresLimits,
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
  acquirePgInstanceLease,
  isPgConflict,
} from "../../../postgres-kit.ts";
import { migrate } from "./schema.ts";
import { type StoredText, type ValueKind, readTexts } from "./values.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };
type Order = "ascending" | "descending";

interface LeaseOptions {
  /** How long a holder that stops renewing keeps the instance. */
  leaseMs: number;
  /** How long an opener waits for a held instance before it refuses. */
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

/**
 * What a database allows one transaction and one value, for one that caps them (Aurora DSQL: 3,000 rows, 10 MiB, 1 MiB
 * a value). Unset, nothing is capped. A commit takes as many transactions as its batches need; a value longer than
 * `bytesPerValue` is stored in parts (values.ts).
 */

const KINDS: Record<string, ValueKind> = {
  durable_conversations: "conversation",
  durable_tasks: "task",
  durable_submissions: "submission",
};

export { InstanceHeld };

export interface OpenOptions {
  /** What else opens the instance, for the refusal of a second opener. */
  holders?: string;
  /** The agent that opens it (its package's name): an instance belongs to the agent that made it. */
  agent?: string;
  lease?: LeaseOptions;
  limits?: PostgresLimits;
  pool?: SharedPostgresHandle;
  canYield?: () => boolean;
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
  private readonly limits: PostgresLimits;

  private constructor(db: PgDatabase, instance: string, lease: PgInstanceLease<number>, limits: PostgresLimits) {
    this.db = db;
    this.instance = instance;
    this.nextId = lease.taken;
    this.lease = lease;
    this.limits = limits;
  }

  /**
   * Open `instance` in `db`, whose tables `migrate` made, holding its lease; the storage owns `db` and closes it. A held
   * instance is waited for (`lease.waitMs`), then refused with `InstanceHeld`, naming `holders`, what else opens it.
   * `onLost` is told once when this process stops holding the instance while open: another took it over, or the
   * database was out of reach for most of the lease. An instance another `agent` made is refused.
   */
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
      ...(options.canYield === undefined ? {} : { canYield: options.canYield }),
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
    return new PostgresStorage(db, instance, lease, options.limits ?? {});
  }

  /**
   * Commit `batches`, each with its own seq, in one transaction, or in as many as the limits make them need. Each batch
   * is checked before it writes anything, against the state the earlier ones left, and the first one refused ends the
   * call: the batches before it are stored. A batch with a copy reads the copy's source, so the batches before it are
   * written first. What the stored batches made unreadable is collected after them.
   */
  async commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
    _context: Context,
  ): Promise<CommitResult> {
    this.assertOpen();
    if (this.lease.lost !== undefined) throw this.lease.lost;
    const seqs: Seq[] = [];
    const garbage = new Map<number, number>();
    let refused: { error: unknown } | undefined;
    try {
      while (refused === undefined && seqs.length < batches.length) {
        const stored = await this.commitTransaction(batches.slice(seqs.length));
        seqs.push(...stored.seqs);
        for (const [id, below] of stored.garbage) garbage.set(id, Math.max(garbage.get(id) ?? 0, below));
        refused = stored.refused;
      }
    } catch (error) {
      // The transactions that committed stand: their batches are durable, the rest are not.
      for (const [index, seq] of seqs.entries()) receive(index, seq);
      throw error;
    }
    for (const [index, seq] of seqs.entries()) receive(index, seq);
    await this.collectGarbage(garbage);
    return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused: refused.error };
  }

  /** The first of `batches` that fit one transaction's limits (at least one), committed together. */
  private async commitTransaction(batches: readonly (readonly StorageWrite[])[]): Promise<{
    seqs: Seq[];
    garbage: ReadonlyMap<number, number>;
    refused: { error: unknown } | undefined;
  }> {
    const { rowsPerTransaction, bytesPerTransaction, bytesPerValue } = this.limits;
    const capped = rowsPerTransaction !== undefined || bytesPerTransaction !== undefined;
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
        // The metadata row's update is one row.
        let rows = 1;
        let bytes = 0;
        for (const writes of batches) {
          const checked = await this.checkBatch(tx, state, pending, writes);
          if ("refused" in checked) {
            refused = { error: checked.refused };
            break;
          }
          if (capped) {
            const cost = batchCost(writes, checked.actions, bytesPerValue);
            const over =
              rows + cost.rows > (rowsPerTransaction ?? Number.POSITIVE_INFINITY) ||
              bytes + cost.bytes > (bytesPerTransaction ?? Number.POSITIVE_INFINITY);
            if (over && seqs.length === 0) {
              throw new Error(
                `a batch of ${cost.rows} rows and ${cost.bytes} bytes is over what the database takes in one ` +
                  `transaction (${rowsPerTransaction ?? "any"} rows, ${bytesPerTransaction ?? "any"} bytes)`,
              );
            }
            // The next transaction takes it, checked again against what this one stored.
            if (over) break;
            rows += cost.rows;
            bytes += cost.bytes;
          }
          const seq = next++ as Seq;
          state.apply(writes, checked.actions, seq);
          pending.add(writes, checked.actions, seq, state);
          seqs.push(seq);
          candidateNextId = Math.max(candidateNextId, this.candidateNextId(writes));
        }
        await pending.flush(tx, this.instance, bytesPerValue);
        if (seqs.length === 0) return;
        const [fenced] = await tx.query(
          "UPDATE durable_metadata SET next_id = $2, next_seq = $3 WHERE instance = $1 AND owner = $4 RETURNING instance",
          [this.instance, Math.max(metadata.next_id, candidateNextId), next, this.lease.owner],
        );
        if (fenced === undefined) throw this.lease.lose();
      })
      .catch((error: unknown) => {
        // A takeover committed while this commit ran: its write of the metadata row won.
        if (isPgConflict(error)) throw this.lease.lose();
        throw error;
      });
    // `COMMIT` returned: the stored batches are durable.
    this.nextId = Math.max(this.nextId, candidateNextId);
    return { seqs, garbage: pending.garbage(), refused };
  }

  /**
   * Delete the revisions a commit made unreadable (each document's below a seq) and their parts, a transaction's
   * rows at a time. Nothing reads them, so one left behind by a failure costs space only, and says so.
   */
  private async collectGarbage(garbage: ReadonlyMap<number, number>): Promise<void> {
    if (garbage.size === 0) return;
    const params = [this.instance, [...garbage.keys()], [...garbage.values()], this.limits.rowsPerTransaction ?? null];
    const statements = [
      `DELETE FROM durable_values WHERE instance = $1 AND kind = 'revision' AND (id, seq, part) IN (
        SELECT v.id, v.seq, v.part FROM durable_values AS v
          JOIN unnest($2::bigint[], $3::bigint[]) AS g(id, below) ON v.id = g.id AND v.seq < g.below
          WHERE v.instance = $1 AND v.kind = 'revision' LIMIT $4) RETURNING 1`,
      `DELETE FROM durable_document_revisions WHERE instance = $1 AND (document_id, seq) IN (
        SELECT r.document_id, r.seq FROM durable_document_revisions AS r
          JOIN unnest($2::bigint[], $3::bigint[]) AS g(id, below) ON r.document_id = g.id AND r.seq < g.below
          WHERE r.instance = $1 LIMIT $4) RETURNING 1`,
    ];
    try {
      for (const statement of statements) {
        let deleted: number;
        do deleted = (await this.db.query(statement, params)).length;
        while (params[3] !== null && deleted === params[3]);
      }
    } catch (error) {
      log.warn(`[fastagent] collecting unreadable revisions of "${this.instance}" failed: ${String(error)}`);
    }
  }

  /**
   * Durable's own checks of one batch, against what the batches before it left: its document actions, or its refusal.
   * Only these checks refuse; a failure of a database call rejects.
   */
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
    await pending.flush(tx, this.instance, this.limits.bytesPerValue);
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

  /** `table`'s records for this instance matching `filters`, in id order from `start`, one more than `limit`. */
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
      KINDS[table] as ValueKind,
      `SELECT id, record AS body, parts FROM ${table} WHERE ${clauses.join(" AND ")}
        ORDER BY id ${ascending ? "ASC" : "DESC"} LIMIT $${params.length}`,
      params,
    );
    return page(values, limit, start.order);
  }

  /** The records `sql` selects as `id, record AS body, parts`, whole and parsed, in its order. */
  private async select<T>(
    executor: PgExecutor,
    kind: ValueKind,
    sql: string,
    params: readonly unknown[],
  ): Promise<T[]> {
    const rows = await executor.query<StoredText>(sql, params);
    return (await readTexts(executor, this.instance, kind, rows)).map((text) => parseJson<T>(text));
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
    const [row] = await this.db.query<StoredText & { commit_seq: number }>(
      "SELECT id, record AS body, parts, commit_seq FROM durable_entries WHERE instance = $1 AND id = $2",
      [this.instance, id],
    );
    if (row === undefined) return undefined;
    const [text] = await readTexts(this.db, this.instance, "entry", [row]);
    const entry = parseJson<EntryRecord>(text as string);
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
        "entry",
        `SELECT id, record AS body, parts FROM durable_entries WHERE instance = $1 AND conversation_id = $2
          AND head IS NOT NULL AND id <= $3 ORDER BY id DESC LIMIT 1`,
        [this.instance, conversation.id, upper ?? Number.MAX_SAFE_INTEGER],
      );
      if (marker !== undefined) return marker;
      if (conversation.parent === undefined) return undefined;
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      conversation = (await this.readConversation(conversation.parent.conversationId)) as ConversationRecord;
    }
  }

  /** One conversation's own entries with ids in `[lower, upper]`, at most `limit`, in `direction`. */
  private async entriesOf(
    conversationId: number,
    lower: number | undefined,
    upper: number | undefined,
    direction: "ASC" | "DESC",
    limit: number,
  ): Promise<EntryRecord[]> {
    return this.select<EntryRecord>(
      this.db,
      "entry",
      `SELECT id, record AS body, parts FROM durable_entries WHERE instance = $1 AND conversation_id = $2
        AND id >= $3 AND id <= $4 ORDER BY id ${direction} LIMIT $5`,
      [this.instance, conversationId, lower ?? 0, upper ?? Number.MAX_SAFE_INTEGER, limit],
    );
  }

  /** Newest first: each conversation of the fork chain from the requested one back, each up to its fork point. */
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

  /** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
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
      "task",
      "SELECT id, record AS body, parts FROM durable_tasks WHERE instance = $1 AND id = $2",
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
      "submission",
      "SELECT id, record AS body, parts FROM durable_submissions WHERE instance = $1 AND id = $2",
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
      "submission",
      `SELECT id, record AS body, parts FROM durable_submissions
        WHERE instance = $1 AND conversation_id = $2 AND request_id = $3`,
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
      "document",
      `SELECT id, record AS body, parts FROM durable_documents WHERE instance = $1 AND kind = $2 AND scope_kind = $3
        AND owner_id = $4 AND family = $5 AND key_value = $6 AND ${alive} ORDER BY created_at DESC LIMIT 1`,
      params,
    );
    return record;
  }

  async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
    this.assertOpen();
    // The record and revision queries must observe one committed state; a commit between them can replace the base.
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
      "document",
      `SELECT id, record AS body, parts FROM durable_documents WHERE ${clauses.join(" AND ")}
        ORDER BY id LIMIT $${params.length}`,
      params,
    );
    return page(records, limit);
  }

  /** Release the lease, then the connections; the reads admitted before finish first. */
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

  /**
   * Run a read that issues several queries. Close waits for admitted reads, so their later queries never reach a
   * closed pool.
   */
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
      "conversation",
      "SELECT id, record AS body, parts FROM durable_conversations WHERE instance = $1 AND id = $2",
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
      "document",
      "SELECT id, record AS body, parts FROM durable_documents WHERE instance = $1 AND id = $2",
      [this.instance, id],
    );
    if (record === undefined) return undefined;
    if (at !== "current" && isCurrentOnly(record)) {
      throw new StorageRequestError(`Document ${id} does not retain historical content`);
    }
    if (!isAliveAt(record, at)) return undefined;
    const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
    type Revision = StoredText & { seq: number; kind: string; version: number };
    const [base] = await tx.query<Revision>(
      `SELECT document_id AS id, seq, kind, version, content AS body, parts FROM durable_document_revisions
        WHERE instance = $1 AND document_id = $2 AND kind = 'base' AND seq <= $3 ORDER BY seq DESC LIMIT 1`,
      [this.instance, id, upper],
    );
    if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
    const tail = await tx.query<Revision>(
      `SELECT document_id AS id, seq, kind, version, content AS body, parts FROM durable_document_revisions
        WHERE instance = $1 AND document_id = $2 AND seq > $3 AND seq <= $4 ORDER BY seq`,
      [this.instance, id, base.seq, upper],
    );
    const [baseText, ...tailTexts] = await readTexts(tx, this.instance, "revision", [base, ...tail]);
    let value = parseJson<JsonObject>(baseText as string);
    for (const [index, revision] of tail.entries()) {
      if (revision.kind !== "delta" || revision.version !== base.version) {
        throw new Error(`Document ${id} crosses a stored version boundary without a base`);
      }
      value = apply(value, parseJson(tailTexts[index] as string)) as JsonObject;
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

  /** Resolve each copy to a base of its source's state before this batch, which may not change the source. */
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

/**
 * Open `instance` in `database` (a connection string, `PostgresDatabase`, or reusable `SharedPostgresDatabase`),
 * making its tables first when it has none. A database that cannot be reached, or refuses, is named in the error,
 * without its credentials.
 */
export async function openPostgresStorage(
  database: string | PostgresDatabase,
  instance: string,
  options: Omit<OpenOptions, "lease" | "limits" | "pool"> & PostgresOptions = {},
): Promise<PostgresStorage> {
  const url = typeof database === "string" ? database : database.url;
  const shared = typeof database === "string" ? undefined : sharedHandleOf(database);
  const limits = options.limits ?? (typeof database === "string" ? undefined : database.limits);
  const password = options.password ?? (typeof database === "string" ? undefined : database.password);
  const createIndex = options.createIndex ?? (typeof database === "string" ? undefined : database.createIndex);
  const { password: _p, createIndex: _c, ...open } = options;
  const openOpts: OpenOptions = { ...open, ...(limits === undefined ? {} : { limits }) };

  if (shared !== undefined) {
    shared.assertOpen();
    try {
      await shared.ensureMigrated("pi-durable", (db) => migrate(db, createIndex));
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
    await migrate(db, createIndex);
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
