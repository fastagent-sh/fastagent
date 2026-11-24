/**
 * The tables of pi-durable's storage in PostgreSQL. Every table is keyed by `instance`, so one database holds any number
 * of instances: a managed database often allows one database and few schemas. The schema is pi-durable's SQLite one
 * (records as JSON text, the columns its queries filter on beside them), plus `durable_leases`, which says which process
 * writes an instance (storage.ts). No sequence, advisory lock or temporary table: the storage needs none, and Aurora
 * DSQL has none.
 */
import type { CreateIndex, PgDatabase } from "../../../postgres.ts";
import { migratePgSchema } from "../../../postgres-kit.ts";

const VERSION = 1;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS durable_metadata (
    instance text PRIMARY KEY, next_id bigint NOT NULL, next_seq bigint NOT NULL, owner text, agent text)`,
  `CREATE TABLE IF NOT EXISTS durable_leases (instance text PRIMARY KEY, owner text, lease_until timestamptz)`,
  `CREATE TABLE IF NOT EXISTS durable_record_ids (
    instance text NOT NULL, id bigint NOT NULL, record_type text NOT NULL, PRIMARY KEY (instance, id))`,
  `CREATE TABLE IF NOT EXISTS durable_conversations (
    instance text NOT NULL, id bigint NOT NULL, owner_conversation_id bigint, owner_task_id bigint, record text NOT NULL, parts integer,
    PRIMARY KEY (instance, id))`,
  `CREATE INDEX IF NOT EXISTS durable_conversations_by_owner_conversation
    ON durable_conversations (instance, owner_conversation_id, id)`,
  `CREATE INDEX IF NOT EXISTS durable_conversations_by_owner_task ON durable_conversations (instance, owner_task_id, id)`,
  `CREATE TABLE IF NOT EXISTS durable_entries (
    instance text NOT NULL, id bigint NOT NULL, conversation_id bigint NOT NULL, head bigint, commit_seq bigint NOT NULL,
    record text NOT NULL, parts integer, PRIMARY KEY (instance, id))`,
  `CREATE INDEX IF NOT EXISTS durable_entries_by_conversation ON durable_entries (instance, conversation_id, id)`,
  // A conversation's latest head marker without reading every entry after it (`findLatestHeadMarker`).
  `CREATE INDEX IF NOT EXISTS durable_entry_heads_by_conversation
    ON durable_entries (instance, conversation_id, id) WHERE head IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS durable_tasks (
    instance text NOT NULL, id bigint NOT NULL, conversation_id bigint NOT NULL, kind text NOT NULL, status text NOT NULL,
    abort_requested smallint NOT NULL, background smallint NOT NULL, record text NOT NULL, parts integer, PRIMARY KEY (instance, id))`,
  `CREATE INDEX IF NOT EXISTS durable_tasks_by_status ON durable_tasks (instance, status, id)`,
  `CREATE INDEX IF NOT EXISTS durable_tasks_by_conversation ON durable_tasks (instance, conversation_id, id)`,
  `CREATE TABLE IF NOT EXISTS durable_submissions (
    instance text NOT NULL, id bigint NOT NULL, conversation_id bigint NOT NULL, request_id text, status text NOT NULL,
    record text NOT NULL, parts integer, PRIMARY KEY (instance, id))`,
  `CREATE INDEX IF NOT EXISTS durable_submissions_by_request ON durable_submissions (instance, conversation_id, request_id)`,
  `CREATE INDEX IF NOT EXISTS durable_submissions_by_status ON durable_submissions (instance, status, id)`,
  `CREATE TABLE IF NOT EXISTS durable_documents (
    instance text NOT NULL, id bigint NOT NULL, kind text NOT NULL, family smallint NOT NULL, key_value text NOT NULL,
    scope_kind text NOT NULL, owner_id bigint NOT NULL, created_at bigint NOT NULL, retired_at bigint, record text NOT NULL, parts integer,
    PRIMARY KEY (instance, id))`,
  `CREATE INDEX IF NOT EXISTS durable_documents_by_address
    ON durable_documents (instance, kind, scope_kind, owner_id, family, key_value, created_at)`,
  `CREATE INDEX IF NOT EXISTS durable_documents_by_scope ON durable_documents (instance, scope_kind, owner_id, id)`,
  `CREATE TABLE IF NOT EXISTS durable_document_revisions (
    instance text NOT NULL, document_id bigint NOT NULL, seq bigint NOT NULL, kind text NOT NULL, version bigint NOT NULL,
    content text NOT NULL, parts integer, PRIMARY KEY (instance, document_id, seq))`,
  // The parts of a value too long for one (values.ts).
  `CREATE TABLE IF NOT EXISTS durable_values (
    instance text NOT NULL, kind text NOT NULL, id bigint NOT NULL, seq bigint NOT NULL, part integer NOT NULL,
    body text NOT NULL, PRIMARY KEY (instance, kind, id, seq, part))`,
  `CREATE TABLE IF NOT EXISTS durable_schema (version integer PRIMARY KEY)`,
];

/** Make the `pi-durable` tables and indexes (idempotent across concurrent openers and Aurora DSQL async jobs). */
export async function migrate(db: PgDatabase, createIndex?: CreateIndex): Promise<void> {
  await migratePgSchema(db, TABLES, {
    ...(createIndex === undefined ? {} : { createIndex }),
    version: { table: "durable_schema", current: VERSION },
  });
}
