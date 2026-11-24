/**
 * A stored record or revision too long for one value of the database (`bytesPerValue`) is kept in parts: its row holds
 * an empty text and how many parts there are, and `durable_values` holds the parts under the row's kind and key. A
 * database that refuses a long value (Aurora DSQL: 1 MiB) takes any record this way. Every read assembles them.
 */
import type { PgExecutor } from "../../../postgres.ts";
export { splitPgText as splitText } from "../../../postgres-kit.ts";

/** What a stored text belongs to: its table, and for a revision its seq beside its document's id. */
export type ValueKind = "conversation" | "entry" | "task" | "submission" | "document" | "revision";

/** A row's text as read: inline when `parts` is null, else that many parts in `durable_values`. */
export interface StoredText {
  readonly id: number;
  readonly seq?: number;
  readonly body: string;
  readonly parts: number | null;
}

/** The whole texts of `rows`, in their order: the parted ones read in one statement. */
export async function readTexts(
  executor: PgExecutor,
  instance: string,
  kind: ValueKind,
  rows: readonly StoredText[],
): Promise<string[]> {
  const parted = rows.filter((row) => row.parts !== null);
  if (parted.length === 0) return rows.map((row) => row.body);
  const found = await executor.query<{ id: number; seq: number; part: number; body: string }>(
    `SELECT v.id, v.seq, v.part, v.body FROM durable_values AS v
      JOIN unnest($3::bigint[], $4::bigint[]) AS k(id, seq) ON v.id = k.id AND v.seq = k.seq
      WHERE v.instance = $1 AND v.kind = $2 ORDER BY v.id, v.seq, v.part`,
    [instance, kind, parted.map((row) => row.id), parted.map((row) => row.seq ?? 0)],
  );
  const bodies = new Map<string, string[]>();
  for (const part of found) {
    const key = `${part.id}:${part.seq}`;
    const list = bodies.get(key) ?? [];
    list[part.part] = part.body;
    bodies.set(key, list);
  }
  return rows.map((row) => {
    if (row.parts === null) return row.body;
    const parts = bodies.get(`${row.id}:${row.seq ?? 0}`) ?? [];
    // A row's parts beyond its count are a longer value's, left by an update: never read.
    let whole = "";
    for (let part = 0; part < row.parts; part++) {
      const body = parts[part];
      if (body === undefined) throw new Error(`the ${kind} ${row.id} is missing part ${part} of its stored value`);
      whole += body;
    }
    return whole;
  });
}
