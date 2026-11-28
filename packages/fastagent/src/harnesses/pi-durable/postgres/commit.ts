/**
 * One `commit()` in a few statements whatever its number of batches, as pi-durable's SQLite storage does it (its
 * `commit.ts`, MIT, which this ports): the stored state every batch's checks need read up front (`CommitState`), each
 * batch checked in memory against what the batches before it left, and the accepted ones written per table
 * (`PendingWrites`), each table's rows as one typed array per column (`unnest`).
 */
import type {
  DocumentContent,
  DocumentCopySource,
  DocumentCreate,
  DocumentRecord,
  Seq,
  StorageWrite,
} from "@earendil-works/pi-durable";
import type { PgExecutor } from "../../../postgres.ts";

type Cell = string | number | null;

export const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value);
/** An indexed string column, as JSON: what pi-durable's SQLite storage stores, so a lone surrogate stays lossless. */
export const encodeIndexedString = (value: string): string => JSON.stringify(value);

type Scope = DocumentRecord["scope"];

export function scopeColumns(scope: Scope): { scopeKind: Scope["kind"]; ownerId: number } {
  switch (scope.kind) {
    case "session":
      return { scopeKind: "session", ownerId: 0 };
    case "conversation":
      return { scopeKind: "conversation", ownerId: scope.conversationId };
    case "task":
      return { scopeKind: "task", ownerId: scope.taskId };
  }
}

export function addressParts(address: { kind: string; scope: Scope; key?: string }) {
  return {
    kind: encodeIndexedString(address.kind),
    ...scopeColumns(address.scope),
    family: address.key === undefined ? 0 : 1,
    keyValue: encodeIndexedString(address.key ?? ""),
  };
}

const addressColumnsKey = (kind: string, scopeKind: string, ownerId: number, family: number, keyValue: string) =>
  JSON.stringify([kind, scopeKind, ownerId, family, keyValue]);

const addressKey = (address: { kind: string; scope: Scope; key?: string }) => {
  const parts = addressParts(address);
  return addressColumnsKey(parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue);
};

/** Whether a document keeps only its current state: its revisions go at each new base and at retirement. */
export const isCurrentOnly = (record: DocumentRecord | DocumentCreate): boolean =>
  record.scope.kind !== "conversation" || record.history === "latest";

type Table = "conversation" | "entry" | "task" | "submission" | "document";

/** The record id a write claims and its table, if it claims one. */
export function claimOf(write: StorageWrite): { id: number; table: Table } | undefined {
  switch (write.type) {
    case "conversation":
    case "entry":
    case "task":
    case "submission":
      return { id: write.value.id, table: write.type };
    case "document.create":
    case "document.copy":
      return { id: write.record.id, table: "document" };
    case "document.change":
    case "document.retire":
      return undefined;
  }
}

export interface DocumentAction {
  create?: DocumentCreate;
  content?: DocumentContent;
  copy?: DocumentCopySource;
  retire: boolean;
}

/** One batch's writes per document; throws when a document gets two content commands or two retirements. */
export function prepareDocumentActions(writes: readonly StorageWrite[]): Map<number, DocumentAction> {
  const actions = new Map<number, DocumentAction>();
  for (const write of writes) {
    if (
      write.type !== "document.create" &&
      write.type !== "document.copy" &&
      write.type !== "document.change" &&
      write.type !== "document.retire"
    ) {
      continue;
    }
    const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
    let action = actions.get(id);
    if (action === undefined) {
      action = { retire: false };
      actions.set(id, action);
    }
    const hasContent = action.create !== undefined || action.content !== undefined || action.copy !== undefined;
    switch (write.type) {
      case "document.create":
        if (hasContent) throw new Error(`Document ${id} has more than one content command`);
        action.create = write.record;
        action.content = write.content;
        break;
      case "document.copy":
        if (hasContent) throw new Error(`Document ${id} has more than one content command`);
        action.create = write.record;
        action.copy = write.source;
        break;
      case "document.change":
        if (action.content !== undefined || action.copy !== undefined) {
          throw new Error(`Document ${id} has more than one content command`);
        }
        action.content = write.content;
        break;
      case "document.retire":
        if (action.retire) throw new Error(`Document ${id} is retired more than once`);
        action.retire = true;
        break;
    }
  }
  return actions;
}

/**
 * What the checks of one call's batches read: the stored state of every id, document and address the batches touch,
 * read in a few statements when the call starts, then advanced in memory by each accepted batch.
 */
export class CommitState {
  private readonly recordIds: Map<number, string>;
  private readonly documents: Map<number, DocumentRecord>;
  private readonly versions: Map<number, number>;
  private readonly current: Map<string, number | undefined>;

  private constructor(
    recordIds: Map<number, string>,
    documents: Map<number, DocumentRecord>,
    versions: Map<number, number>,
    current: Map<string, number | undefined>,
  ) {
    this.recordIds = recordIds;
    this.documents = documents;
    this.versions = versions;
    this.current = current;
  }

  static async read(tx: PgExecutor, instance: string, batches: readonly (readonly StorageWrite[])[]) {
    const ids = new Set<number>();
    const documentIds = new Set<number>();
    const deltaIds = new Set<number>();
    const addresses = new Map<string, ReturnType<typeof addressParts>>();
    for (const writes of batches) {
      for (const write of writes) {
        const claim = claimOf(write);
        if (claim !== undefined) ids.add(claim.id);
        switch (write.type) {
          case "document.create":
          case "document.copy":
            documentIds.add(write.record.id);
            addresses.set(addressKey(write.record), addressParts(write.record));
            break;
          case "document.change":
            documentIds.add(write.id);
            if (write.content.kind === "delta") deltaIds.add(write.id);
            break;
          case "document.retire":
            documentIds.add(write.id);
            break;
          default:
            break;
        }
      }
    }
    const recordIds = new Map<number, string>();
    if (ids.size > 0) {
      const rows = await tx.query<{ id: number; record_type: string }>(
        "SELECT id, record_type FROM durable_record_ids WHERE instance = $1 AND id = ANY($2::bigint[])",
        [instance, [...ids]],
      );
      for (const row of rows) recordIds.set(row.id, row.record_type);
    }
    const documents = new Map<number, DocumentRecord>();
    if (documentIds.size > 0) {
      const rows = await tx.query<{ record: string }>(
        "SELECT record FROM durable_documents WHERE instance = $1 AND id = ANY($2::bigint[])",
        [instance, [...documentIds]],
      );
      for (const row of rows) {
        const record = parseJson<DocumentRecord>(row.record);
        documents.set(record.id, record);
      }
    }
    const versions = new Map<number, number>();
    if (deltaIds.size > 0) {
      const rows = await tx.query<{ document_id: number; version: number | null }>(
        `SELECT requested.id AS document_id, (
          SELECT version FROM durable_document_revisions
            WHERE instance = $1 AND document_id = requested.id ORDER BY seq DESC LIMIT 1
        ) AS version FROM unnest($2::bigint[]) AS requested(id)`,
        [instance, [...deltaIds]],
      );
      for (const row of rows) if (row.version !== null) versions.set(row.document_id, row.version);
    }
    const current = new Map<string, number | undefined>();
    for (const key of addresses.keys()) current.set(key, undefined);
    if (addresses.size > 0) {
      const parts = [...addresses.values()];
      const rows = await tx.query<{
        id: number;
        kind: string;
        scope_kind: string;
        owner_id: number;
        family: number;
        key_value: string;
      }>(
        `SELECT d.id, d.kind, d.scope_kind, d.owner_id, d.family, d.key_value
          FROM unnest($2::text[], $3::text[], $4::bigint[], $5::smallint[], $6::text[])
            AS a(kind, scope_kind, owner_id, family, key_value)
          JOIN durable_documents AS d ON d.instance = $1 AND d.kind = a.kind AND d.scope_kind = a.scope_kind
            AND d.owner_id = a.owner_id AND d.family = a.family AND d.key_value = a.key_value
          WHERE d.retired_at IS NULL`,
        [
          instance,
          parts.map((p) => p.kind),
          parts.map((p) => p.scopeKind),
          parts.map((p) => p.ownerId),
          parts.map((p) => p.family),
          parts.map((p) => p.keyValue),
        ],
      );
      for (const row of rows) {
        current.set(addressColumnsKey(row.kind, row.scope_kind, row.owner_id, row.family, row.key_value), row.id);
      }
    }
    return new CommitState(recordIds, documents, versions, current);
  }

  check(writes: readonly StorageWrite[], actions: Map<number, DocumentAction>): void {
    this.checkIds(writes);
    this.checkDocuments(actions);
  }

  apply(writes: readonly StorageWrite[], actions: Map<number, DocumentAction>, seq: Seq): void {
    for (const write of writes) {
      const claim = claimOf(write);
      if (claim !== undefined) this.recordIds.set(claim.id, claim.table);
    }
    for (const [id, action] of actions) {
      if (action.create !== undefined) {
        const record = {
          ...action.create,
          createdAt: seq,
          ...(action.retire ? { retiredAt: seq } : {}),
        } as DocumentRecord;
        this.documents.set(id, record);
        if (!action.retire) this.current.set(addressKey(record), id);
      } else if (action.retire) {
        const record = { ...(this.documents.get(id) as DocumentRecord), retiredAt: seq };
        this.documents.set(id, record);
        const key = addressKey(record);
        if (this.current.get(key) === id) this.current.set(key, undefined);
      }
      if (action.content !== undefined) this.versions.set(id, action.content.version);
    }
  }

  document(id: number): DocumentRecord | undefined {
    return this.documents.get(id);
  }

  private checkIds(writes: readonly StorageWrite[]): void {
    const claimed = new Map<number, Table>();
    for (const write of writes) {
      const claim = claimOf(write);
      if (claim === undefined) continue;
      const { id, table } = claim;
      const existing = this.recordIds.get(id);
      const earlier = claimed.get(id);
      if (table === "conversation" || table === "entry" || table === "document") {
        if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
      } else {
        if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
      }
      claimed.set(id, table);
    }
  }

  private checkDocuments(actions: Map<number, DocumentAction>): void {
    const liveCounts = new Map<string, number>();
    for (const [id, action] of actions) {
      if (action.copy !== undefined && actions.has(action.copy.id)) {
        throw new Error(`Document copy ${id} source is changed in the copy batch`);
      }
      const existing = this.documents.get(id);
      if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
      if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
      if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
      if (action.content?.kind === "delta") {
        const previous = this.versions.get(id);
        if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
        if (previous !== action.content.version) throw new Error(`Document ${id} version transition requires a base`);
      }
      if (action.create === undefined && !action.retire) continue;
      const key = addressKey((action.create ?? existing) as DocumentRecord);
      let live = liveCounts.get(key) ?? (this.current.get(key) === undefined ? 0 : 1);
      if (action.retire && existing !== undefined) live--;
      if (action.create !== undefined && !action.retire) live++;
      liveCounts.set(key, live);
    }
    for (const live of liveCounts.values()) {
      if (live > 1) throw new Error("Document address already has a current incarnation");
    }
  }
}

/** Inserts `rows` into `table` for `instance`: one typed array per column, through `unnest`. */
async function insertRows(
  tx: PgExecutor,
  instance: string,
  table: string,
  columns: readonly (readonly [name: string, type: string])[],
  rows: readonly (readonly Cell[])[],
  conflict = "",
): Promise<void> {
  if (rows.length === 0) return;
  const names = ["instance", ...columns.map(([name]) => name)].join(", ");
  const arrays = columns.map(([, type], index) => `$${index + 2}::${type}[]`).join(", ");
  await tx.query(`INSERT INTO ${table} (${names}) SELECT $1, * FROM unnest(${arrays}) ${conflict}`, [
    instance,
    ...columns.map((_, index) => rows.map((row) => row[index])),
  ]);
}

function documentRow(record: DocumentRecord): Cell[] {
  const parts = addressParts(record);
  return [
    record.id,
    parts.kind,
    parts.family,
    parts.keyValue,
    parts.scopeKind,
    parts.ownerId,
    record.createdAt,
    record.retiredAt ?? null,
    encodeJson(record),
  ];
}

export class PendingWrites {
  private readonly recordIds = new Map<number, string>();
  private readonly conversations: Cell[][] = [];
  private readonly entries: Cell[][] = [];
  private readonly tasks = new Map<number, Cell[]>();
  private readonly submissions = new Map<number, Cell[]>();
  private readonly documents = new Map<number, DocumentRecord>();
  private readonly cleared = new Map<number, number>();
  private readonly revisions = new Map<number, Cell[][]>();

  add(writes: readonly StorageWrite[], actions: Map<number, DocumentAction>, seq: Seq, state: CommitState): void {
    for (const write of writes) this.addWrite(write, seq);
    for (const [id, action] of actions) this.addDocument(id, action, seq, state.document(id) as DocumentRecord);
  }

  private addWrite(write: StorageWrite, seq: Seq): void {
    const claim = claimOf(write);
    if (claim !== undefined) this.recordIds.set(claim.id, claim.table);
    switch (write.type) {
      case "conversation": {
        const value = write.value;
        this.conversations.push([
          value.id,
          value.owner?.conversationId ?? null,
          value.owner?.taskId ?? null,
          encodeJson(value),
        ]);
        break;
      }
      case "entry": {
        const value = write.value;
        this.entries.push([value.id, value.conversationId, value.head ?? null, seq, encodeJson(value)]);
        break;
      }
      case "task": {
        const value = write.value;
        this.tasks.set(value.id, [
          value.id,
          value.conversationId,
          encodeIndexedString(value.kind),
          value.state.status,
          value.abortRequested ? 1 : 0,
          value.background ? 1 : 0,
          encodeJson(value),
        ]);
        break;
      }
      case "submission": {
        const value = write.value;
        this.submissions.set(value.id, [
          value.id,
          value.conversationId,
          value.requestId === undefined ? null : encodeIndexedString(value.requestId),
          value.status,
          encodeJson(value),
        ]);
        break;
      }
      default:
        break;
    }
  }

  private addDocument(id: number, action: DocumentAction, seq: Seq, record: DocumentRecord): void {
    if (action.create !== undefined || action.retire) this.documents.set(id, record);
    const content = action.content;
    if (content !== undefined) {
      if (content.kind === "base" && isCurrentOnly(record)) this.clear(id, seq);
      const encoded = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
      let revisions = this.revisions.get(id);
      if (revisions === undefined) {
        revisions = [];
        this.revisions.set(id, revisions);
      }
      revisions.push([id, seq, content.kind, content.version, encoded]);
    }
    if (action.retire && isCurrentOnly(record)) this.clear(id, Number.MAX_SAFE_INTEGER);
  }

  private clear(id: number, seq: number): void {
    this.cleared.set(id, Math.max(this.cleared.get(id) ?? 0, seq));
    this.revisions.delete(id);
  }

  garbage(): ReadonlyMap<number, number> {
    return this.cleared;
  }

  async flush(tx: PgExecutor, instance: string): Promise<void> {
    await insertRows(
      tx,
      instance,
      "durable_record_ids",
      [
        ["id", "bigint"],
        ["record_type", "text"],
      ],
      [...this.recordIds],
      "ON CONFLICT (instance, id) DO NOTHING",
    );
    await insertRows(
      tx,
      instance,
      "durable_conversations",
      [
        ["id", "bigint"],
        ["owner_conversation_id", "bigint"],
        ["owner_task_id", "bigint"],
        ["record", "text"],
      ],
      this.conversations,
    );
    await insertRows(
      tx,
      instance,
      "durable_entries",
      [
        ["id", "bigint"],
        ["conversation_id", "bigint"],
        ["head", "bigint"],
        ["commit_seq", "bigint"],
        ["record", "text"],
      ],
      this.entries,
    );
    await insertRows(
      tx,
      instance,
      "durable_tasks",
      [
        ["id", "bigint"],
        ["conversation_id", "bigint"],
        ["kind", "text"],
        ["status", "text"],
        ["abort_requested", "smallint"],
        ["background", "smallint"],
        ["record", "text"],
      ],
      [...this.tasks.values()],
      `ON CONFLICT (instance, id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
        status = excluded.status, abort_requested = excluded.abort_requested, background = excluded.background,
        record = excluded.record`,
    );
    await insertRows(
      tx,
      instance,
      "durable_submissions",
      [
        ["id", "bigint"],
        ["conversation_id", "bigint"],
        ["request_id", "text"],
        ["status", "text"],
        ["record", "text"],
      ],
      [...this.submissions.values()],
      `ON CONFLICT (instance, id) DO UPDATE SET conversation_id = excluded.conversation_id,
        request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
    );
    await insertRows(
      tx,
      instance,
      "durable_documents",
      [
        ["id", "bigint"],
        ["kind", "text"],
        ["family", "smallint"],
        ["key_value", "text"],
        ["scope_kind", "text"],
        ["owner_id", "bigint"],
        ["created_at", "bigint"],
        ["retired_at", "bigint"],
        ["record", "text"],
      ],
      [...this.documents.values()].map(documentRow),
      "ON CONFLICT (instance, id) DO UPDATE SET retired_at = excluded.retired_at, record = excluded.record",
    );
    await insertRows(
      tx,
      instance,
      "durable_document_revisions",
      [
        ["document_id", "bigint"],
        ["seq", "bigint"],
        ["kind", "text"],
        ["version", "bigint"],
        ["content", "text"],
      ],
      [...this.revisions.values()].flat(),
    );
    this.recordIds.clear();
    this.conversations.length = 0;
    this.entries.length = 0;
    this.tasks.clear();
    this.submissions.clear();
    this.documents.clear();
    this.revisions.clear();
  }
}
