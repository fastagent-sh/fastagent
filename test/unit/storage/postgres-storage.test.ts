import { existsSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type PgDatabase,
  openPgDatabase,
  openPostgresDatabase,
  sharedHandleOf,
} from "../../../packages/fastagent/src/postgres.ts";
import { acquirePgInstanceLease, migratePgSchema, splitPgText } from "../../../packages/fastagent/src/postgres-kit.ts";
import { migrate } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/schema.ts";
import {
  InstanceHeld,
  PostgresStorage,
  openPostgresStorage,
} from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/storage.ts";
import { fauxAgent } from "../../doubles/cli-run.ts";
import { type ServedPostgres, freshInstance, servedPostgres } from "../../doubles/postgres-double.ts";
import { openSource } from "../../harnesses/open-source.ts";

let postgres: ServedPostgres;
beforeAll(async () => {
  postgres = await servedPostgres();
});
afterAll(() => postgres.close());

registerStorageConformance({ describe, expect, it }, "pi-durable's storage contract, on PostgreSQL", async (use) => {
  const storage = await openPostgresStorage(postgres.url, freshInstance());
  try {
    await use(storage);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
});

/** Limits small enough that most records are in parts, and large enough for the suite's largest batch. */
const TIGHT = { rowsPerTransaction: 600, bytesPerTransaction: 64 * 1024, bytesPerValue: 256 };

registerStorageConformance(
  { describe, expect, it },
  "pi-durable's storage contract, on PostgreSQL that caps transactions and values",
  async (use) => {
    const storage = await openPostgresStorage(postgres.url, freshInstance(), { limits: TIGHT });
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
);

/** Commit a new conversation: what a Session's first write is. */
async function newConversation(storage: Storage): Promise<number> {
  const id = await storage.mintId();
  const write = { type: "conversation", value: { id } } as unknown as StorageWrite;
  const { stored } = await storage.commit([[write]], () => {}, BACKGROUND_CONTEXT);
  expect(stored).toBe(1);
  return id;
}

/** The instance opened with a lease of its own, as a test can stall it. */
async function leased(instance: string, lease: { leaseMs: number; waitMs: number }, holders?: string, agent?: string) {
  const db = openPgDatabase(postgres.url);
  await migrate(db);
  const named = { ...(holders === undefined ? {} : { holders }), ...(agent === undefined ? {} : { agent }) };
  return PostgresStorage.open(db, instance, { lease, ...named }).catch(async (error: unknown) => {
    await db.close();
    throw error;
  });
}

describe("an instance in a shared database", () => {
  it("keeps its sessions and ids across a reopen", async () => {
    const instance = freshInstance();
    const first = await openPostgresStorage(postgres.url, instance);
    const id = await newConversation(first);
    await first.close(BACKGROUND_CONTEXT);
    const again = await openPostgresStorage(postgres.url, instance);
    expect(await again.conversation(id as never, BACKGROUND_CONTEXT)).toEqual({ id });
    expect(await again.mintId()).toBeGreaterThan(id);
    await again.close(BACKGROUND_CONTEXT);
  });

  it("is apart from every other instance in it", async () => {
    const [a, b] = await Promise.all([
      openPostgresStorage(postgres.url, freshInstance()),
      openPostgresStorage(postgres.url, freshInstance()),
    ]);
    const id = await newConversation(a);
    expect(await b.conversation(id as never, BACKGROUND_CONTEXT)).toBeUndefined();
    expect((await b.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT)).items).toEqual([]);
    await Promise.all([a.close(BACKGROUND_CONTEXT), b.close(BACKGROUND_CONTEXT)]);
  });
});

describe("a database that caps transactions and values", () => {
  const conversationWrites = async (storage: Storage, count: number, text = "") => {
    const batches: StorageWrite[][] = [];
    for (let i = 0; i < count; i++) {
      batches.push([{ type: "conversation", value: { id: await storage.mintId(), text } } as unknown as StorageWrite]);
    }
    return batches;
  };
  /** Rows each transaction wrote into the instance's records and ids, and their bytes: a row's `xmin` is its writer's. */
  const perTransaction = async (instance: string) => {
    const db = openPgDatabase(postgres.url);
    const rows = await db.query<{ rows: number; bytes: number }>(
      `SELECT count(*)::int AS rows, sum(octet_length(body))::int AS bytes FROM (
        SELECT xmin::text AS tx, '' AS body FROM durable_record_ids WHERE instance = $1
        UNION ALL SELECT xmin::text, record FROM durable_conversations WHERE instance = $1
        UNION ALL SELECT xmin::text, body FROM durable_values WHERE instance = $1) AS written GROUP BY tx`,
      [instance],
    );
    await db.close();
    return rows;
  };

  it("commits a call over a transaction's rows in several transactions, none over, all of it stored", async () => {
    const instance = freshInstance();
    const storage = await openPostgresStorage(postgres.url, instance, { limits: { rowsPerTransaction: 10 } });
    const batches = await conversationWrites(storage, 30);
    const seqs: number[] = [];
    expect(await storage.commit(batches, (_, seq) => seqs.push(seq), BACKGROUND_CONTEXT)).toEqual({
      kind: "stored",
      stored: 30,
    });
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect((await storage.scanConversations({}, 100, undefined, BACKGROUND_CONTEXT)).items).toHaveLength(30);
    const transactions = await perTransaction(instance);
    expect(transactions.length).toBeGreaterThan(1);
    // The metadata row is the tenth row of each.
    for (const { rows } of transactions) expect(rows).toBeLessThanOrEqual(9);
    await storage.close(BACKGROUND_CONTEXT);
  });

  it("commits a call over a transaction's bytes in several transactions, none over", async () => {
    const instance = freshInstance();
    const storage = await openPostgresStorage(postgres.url, instance, { limits: { bytesPerTransaction: 4_000 } });
    expect(
      await storage.commit(await conversationWrites(storage, 10, "x".repeat(900)), () => {}, BACKGROUND_CONTEXT),
    ).toEqual({
      kind: "stored",
      stored: 10,
    });
    const transactions = await perTransaction(instance);
    expect(transactions.length).toBeGreaterThan(1);
    for (const { bytes } of transactions) expect(bytes).toBeLessThanOrEqual(4_000);
    await storage.close(BACKGROUND_CONTEXT);
  });

  it("refuses a single batch over a transaction's limits, storing nothing, and says by how much", async () => {
    const storage = await openPostgresStorage(postgres.url, freshInstance(), { limits: { rowsPerTransaction: 3 } });
    const [first, second] = await conversationWrites(storage, 2);
    await expect(
      storage.commit([[...(first as StorageWrite[]), ...(second as StorageWrite[])]], () => {}, BACKGROUND_CONTEXT),
    ).rejects.toThrow("a batch of 4 rows and ");
    expect((await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT)).items).toEqual([]);
    await storage.close(BACKGROUND_CONTEXT);
  });

  it("returns tagged refused CommitResult after storing earlier valid batches", async () => {
    const storage = await openPostgresStorage(postgres.url, freshInstance());
    const [validBatch] = await conversationWrites(storage, 1);
    const missingDocId = await storage.mintId();
    const invalidBatch: StorageWrite[] = [
      { type: "document.change", id: missingDocId, content: { version: 1, kind: "base", value: {} } } as StorageWrite,
    ];
    const result = await storage.commit([validBatch as StorageWrite[], invalidBatch], () => {}, BACKGROUND_CONTEXT);
    expect(result).toMatchObject({ kind: "refused", stored: 1 });
    if (result.kind === "refused") expect(result.refused).toBeInstanceOf(Error);
    await storage.close(BACKGROUND_CONTEXT);
  });

  it("keeps a record longer than a value in parts, none over, and reads it back whole", async () => {
    const instance = freshInstance();
    const storage = await openPostgresStorage(postgres.url, instance, { limits: { bytesPerValue: 100 } });
    // Three-byte and four-byte characters across the parts' edges.
    const text = "汉字🙂".repeat(80);
    const batch = (await conversationWrites(storage, 1, text))[0] as StorageWrite[];
    await storage.commit([batch], () => {}, BACKGROUND_CONTEXT);
    const id = (batch[0] as unknown as { value: { id: number } }).value.id;
    expect(await storage.conversation(id as never, BACKGROUND_CONTEXT)).toEqual({ id, text });
    const db = openPgDatabase(postgres.url);
    const [stored] = await db.query<{ parts: number; longest: number }>(
      `SELECT c.parts, (SELECT max(octet_length(body)) FROM durable_values WHERE instance = $1) AS longest
        FROM durable_conversations AS c WHERE c.instance = $1`,
      [instance],
    );
    await db.close();
    expect(stored?.parts).toBeGreaterThan(1);
    expect(stored?.longest).toBeLessThanOrEqual(100);
    await storage.close(BACKGROUND_CONTEXT);
  });

  it("collects the revisions and parts new bases make unreadable, a transaction's rows at a time", async () => {
    const instance = freshInstance();
    const storage = await openPostgresStorage(postgres.url, instance, {
      limits: { rowsPerTransaction: 20, bytesPerValue: 64 },
    });
    const base = (n: number) => ({ version: 1, kind: "base", value: { n, filler: "y".repeat(400) } });
    const commit = (batches: unknown[][]) => storage.commit(batches as StorageWrite[][], () => {}, BACKGROUND_CONTEXT);
    const ids: number[] = [];
    for (const kind of ["test.a", "test.b", "test.c"]) {
      const id = await storage.mintId();
      ids.push(id);
      await commit([[{ type: "document.create", record: { id, kind, scope: { kind: "session" } }, content: base(1) }]]);
    }
    // One call replacing all three: its garbage, every part of three bases, is more than one transaction's rows.
    await commit(ids.map((id) => [{ type: "document.change", id, content: base(2) }]));
    for (const id of ids) {
      expect((await storage.document(id as never, "current", BACKGROUND_CONTEXT))?.value).toMatchObject({ n: 2 });
    }
    const db = openPgDatabase(postgres.url);
    const [left] = await db.query<{ revisions: number; parted: number }>(
      `SELECT (SELECT count(*)::int FROM durable_document_revisions WHERE instance = $1) AS revisions,
        (SELECT count(DISTINCT (id, seq))::int FROM durable_values WHERE instance = $1 AND kind = 'revision') AS parted`,
      [instance],
    );
    await db.close();
    expect(left).toEqual({ revisions: 3, parted: 3 });
    await storage.close(BACKGROUND_CONTEXT);
  });

  it("makes each index the way it is given: started one at a time, and the jobs waited for together", async () => {
    const fresh = await servedPostgres();
    try {
      const made: string[] = [];
      // Each index a job that takes a while, as a database that builds them as jobs makes it. Its statements one at a
      // time, as such a database refuses two schema changes at once; its jobs waited for together.
      let starting = 0;
      let mostStarting = 0;
      let waiting = 0;
      let mostWaiting = 0;
      const storage = await openPostgresStorage(fresh.url, freshInstance(), {
        createIndex: async (db, statement) => {
          made.push(statement.split(/\s+/).slice(0, 6).join(" "));
          starting += 1;
          mostStarting = Math.max(mostStarting, starting);
          await db.query(statement);
          starting -= 1;
          return async () => {
            waiting += 1;
            mostWaiting = Math.max(mostWaiting, waiting);
            await new Promise((resolve) => setTimeout(resolve, 20));
            waiting -= 1;
          };
        },
      });
      expect([made.length > 1, mostStarting, mostWaiting]).toEqual([true, 1, made.length]);
      expect(made.every((statement) => statement.startsWith("CREATE INDEX IF NOT EXISTS durable_"))).toBe(true);
      await storage.close(BACKGROUND_CONTEXT);
    } finally {
      await fresh.close();
    }
  });
});

it("an app's agent on a database it gives, which caps a transaction, refuses a message over four fifths of it", async () => {
  const dir = await fauxAgent("fa-postgres-capped-");
  const agent = await openSource(dir, {
    name: "capped",
    database: { url: postgres.url, limits: { bytesPerTransaction: 10_000 } },
  });
  try {
    // Its sessions are in the database it was given, not beside it.
    expect(existsSync(join(dir, ".state", "agent.sqlite"))).toBe(false);
    const { id: sessionId } = await agent.sessions.create();
    await expect(agent.messages.send({ sessionId, content: "x".repeat(8_100) })).rejects.toMatchObject({
      code: "invalid_request",
      details: { reason: "too_large" },
    });
    const answered = await agent.messages.send({ sessionId, content: "x".repeat(7_900) }, { wait: 30 });
    expect([answered.status, answered.answer?.text]).toEqual(["completed", "seen 1"]);
  } finally {
    await agent.close();
  }
});

describe("an instance belongs to the agent that made it", () => {
  it("refuses another agent that opens it by the same name, naming both, and changes nothing", async () => {
    const instance = freshInstance();
    const made = await openPostgresStorage(postgres.url, instance, { agent: "@acme/support" });
    const id = await newConversation(made);
    await made.close(BACKGROUND_CONTEXT);
    await expect(openPostgresStorage(postgres.url, instance, { agent: "@acme/sales" })).rejects.toThrow(
      `the instance "${instance}" belongs to the agent "@acme/support", not "@acme/sales": give this one another name (FASTAGENT_NAME)`,
    );
    // The refused open took no lease: the owner opens it again at once, as it left it.
    const again = await leased(instance, { leaseMs: 60_000, waitMs: 0 }, undefined, "@acme/support");
    expect(await again.conversation(id as never, BACKGROUND_CONTEXT)).toEqual({ id });
    await again.close(BACKGROUND_CONTEXT);
  });

  it("is opened only by the name it is given: an app that names none is refused", async () => {
    const dir = await fauxAgent("fa-postgres-unnamed-");
    await expect(
      openSource(dir, { secrets: { ...process.env, FASTAGENT_DATABASE_URL: postgres.url } }),
    ).rejects.toThrow(
      "an instance in a database is opened by its name, and none was given: set FASTAGENT_NAME (an app: openAgent's name)",
    );
  });
});

describe("one process writes an instance at a time", () => {
  it("refuses a second opener while the first holds it, naming what else opens it", async () => {
    const instance = freshInstance();
    const first = await leased(instance, { leaseMs: 60_000, waitMs: 0 });
    await expect(leased(instance, { leaseMs: 60_000, waitMs: 300 }, "another `fastagent start`")).rejects.toThrow(
      new RegExp(
        `^the instance "${instance}" is held by another process until .+: another \`fastagent start\` is running`,
      ),
    );
    await expect(leased(instance, { leaseMs: 60_000, waitMs: 0 })).rejects.toBeInstanceOf(InstanceHeld);
    await first.close(BACKGROUND_CONTEXT);
  });

  it("hands the instance over at close at once", async () => {
    const instance = freshInstance();
    const first = await leased(instance, { leaseMs: 60_000, waitMs: 0 });
    await first.close(BACKGROUND_CONTEXT);
    const second = await leased(instance, { leaseMs: 60_000, waitMs: 0 });
    await second.close(BACKGROUND_CONTEXT);
  });

  it("refuses the commit of a holder that stalled past its lease once another took the instance over", async () => {
    const instance = freshInstance();
    const stalled = await leased(instance, { leaseMs: 60_000, waitMs: 0 });
    await newConversation(stalled);
    // The holder stalled: its lease ran out without a renewal.
    const db = openPgDatabase(postgres.url);
    await db.query("UPDATE durable_leases SET lease_until = now() - interval '1 second' WHERE instance = $1", [
      instance,
    ]);
    await db.close();
    const successor = await leased(instance, { leaseMs: 60_000, waitMs: 0 });
    await expect(newConversation(stalled)).rejects.toThrow(
      `the instance "${instance}" was taken over by another process`,
    );
    await newConversation(successor);
    await successor.close(BACKGROUND_CONTEXT);
    await stalled.close(BACKGROUND_CONTEXT);
  });
});

describe("a holder cut off from the database", () => {
  it("gives the instance up, saying so, while its lease still keeps a successor out", async () => {
    const instance = freshInstance();
    const base = openPgDatabase(postgres.url);
    await migrate(base);
    let cut = false;
    const unreachable = () =>
      Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const db: PgDatabase = {
      query: (text, params) => (cut ? unreachable() : base.query(text, params)),
      transaction: (work) => (cut ? unreachable() : base.transaction(work)),
      close: () => base.close(),
    };
    const lost: Error[] = [];
    const leaseMs = 3_000;
    const holder = await PostgresStorage.open(db, instance, {
      lease: { leaseMs, waitMs: 0 },
      onLost: (error) => lost.push(error),
    });
    cut = true;
    await vi.waitFor(() => expect(lost).toHaveLength(1), { timeout: 10_000 });
    expect(lost[0]?.message).toMatch(
      new RegExp(`^the instance "${instance}" was given up: its lease went \\d+s without`),
    );
    const watcher = openPgDatabase(postgres.url);
    const [lease] = await watcher.query<{ current: boolean }>(
      "SELECT lease_until > now() AS current FROM durable_leases WHERE instance = $1",
      [instance],
    );
    await watcher.close();
    expect(lease?.current).toBe(true);
    cut = false;
    await expect(newConversation(holder)).rejects.toThrow(`the instance "${instance}" was given up`);
    await holder.close(BACKGROUND_CONTEXT);
  });
});

it("an open agent stops its runs once another process takes its instance over", async () => {
  // Only the lease's renewal ticks are driven by hand; everything else runs on real time.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const dir = await fauxAgent("fa-postgres-taken-");
    const agent = await openSource(dir, {
      name: "taken",
      secrets: { ...process.env, FASTAGENT_DATABASE_URL: postgres.url },
    });
    let closed = false;
    void agent.closed?.then(() => {
      closed = true;
    });
    const db = openPgDatabase(postgres.url);
    await db.query("UPDATE durable_leases SET lease_until = now() - interval '1 second' WHERE instance = 'taken'");
    await db.close();
    const successor = await leased("taken", { leaseMs: 60_000, waitMs: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
    await successor.close(BACKGROUND_CONTEXT);
    await agent.close();
  } finally {
    vi.useRealTimers();
  }
});

it("names an unreachable database without its credentials", async () => {
  const opening = openPostgresStorage("postgres://agent:s3cret@127.0.0.1:1/agents", freshInstance());
  await expect(opening).rejects.toThrow(/^the database 127\.0\.0\.1:1\/agents: /);
  await expect(opening).rejects.not.toThrow(/s3cret/);
});

describe("openPostgresDatabase: shared connection pool across multiple instances", () => {
  it("migrates once across concurrent opens, keeps the pool alive when individual instances close, and refuses opens after close", async () => {
    const fresh = await servedPostgres();
    let createIndexCalls = 0;
    const shared = openPostgresDatabase(
      {
        url: fresh.url,
        createIndex: async (db, statement) => {
          createIndexCalls += 1;
          await db.query(statement);
        },
      },
      { max: 4, idleTimeoutMillis: 1_000 },
    );
    try {
      const dir = await fauxAgent("fa-shared-pg-");
      const [a, b, c] = await Promise.all([
        openSource(dir, { name: "tenant-a", database: shared }),
        openSource(dir, { name: "tenant-b", database: shared }),
        openSource(dir, { name: "tenant-c", database: shared }),
      ]);
      // Single-flight migration ran once across all three concurrent opens.
      const callsAfterFirst = createIndexCalls;
      expect(callsAfterFirst).toBeGreaterThan(0);

      const sessionA = await a.sessions.create();
      const sessionB = await b.sessions.create();
      expect((await a.messages.send({ sessionId: sessionA.id, content: "hi a" }, { wait: 15 })).status).toBe(
        "completed",
      );

      // Closing instance A releases its lease immediately without closing the shared pool or disturbing B.
      await a.close();
      expect((await b.messages.send({ sessionId: sessionB.id, content: "hi b" }, { wait: 15 })).status).toBe(
        "completed",
      );

      // Named conversations persist in PostgreSQL and stay isolated per instance.
      const convB = await b.invoke({ conversation: "ops", content: "from b" }, { wait: 15 });
      expect(convB.status).toBe("completed");

      // Reopening tenant-a reuses the shared pool and runs zero additional migrations.
      const aAgain = await openSource(dir, { name: "tenant-a", database: shared });
      expect(createIndexCalls).toBe(callsAfterFirst);
      expect((await aAgain.sessions.get(sessionA.id)).id).toBe(sessionA.id);
      const convA1 = await aAgain.invoke({ conversation: "ops", content: "from a 1" }, { wait: 15 });
      expect(convA1.sessionId).not.toBe(convB.sessionId);
      await aAgain.close();

      const aThird = await openSource(dir, { name: "tenant-a", database: shared });
      const convA2 = await aThird.invoke({ conversation: "ops", content: "from a 2" }, { wait: 15 });
      expect(convA2.sessionId).toBe(convA1.sessionId);
      await aThird.close();
      await b.close();
      await c.close();

      // Closing the shared handle is idempotent and rejects later opens.
      await shared.close();
      await shared.close();
      await expect(openPostgresStorage(shared, "tenant-d")).rejects.toThrow(/is closed/);
    } finally {
      await shared.close();
      await fresh.close();
    }
  });

  it("refuses invalid pool options up front", () => {
    expect(() => openPostgresDatabase({ url: postgres.url }, { max: 0 })).toThrow(/max must be a positive integer/);
    expect(() => openPostgresDatabase({ url: postgres.url }, { max: 1.5 })).toThrow(/max must be a positive integer/);
    expect(() => openPostgresDatabase({ url: postgres.url }, { idleTimeoutMillis: -1 })).toThrow(
      /idleTimeoutMillis must be a non-negative number/,
    );
  });
});

describe("postgres-kit shared storage primitives", () => {
  it("migrates tables + UNIQUE indexes via createIndex, tolerates concurrent DDL codes, and rejects newer schema versions", async () => {
    const executed: string[] = [];
    const indexed: string[] = [];
    let version = 0;
    const db = {
      query: async <T extends object>(text: string) => {
        executed.push(text);
        if (text.startsWith("SELECT max(version)")) return [{ version }] as T[];
        if (text.includes("table_race")) throw Object.assign(new Error("duplicate"), { code: "42P07" });
        if (text.startsWith("INSERT INTO kit_schema")) version = 1;
        return [] as T[];
      },
    };
    await migratePgSchema(
      db,
      [
        "CREATE TABLE IF NOT EXISTS table_race (id INT PRIMARY KEY)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_u ON table_race (id)",
      ],
      {
        createIndex: async (_exec, stmt) => {
          indexed.push(stmt);
          return async () => {};
        },
        version: { table: "kit_schema", current: 1 },
      },
    );
    expect(indexed).toEqual(["CREATE UNIQUE INDEX IF NOT EXISTS idx_u ON table_race (id)"]);

    version = 2;
    await expect(migratePgSchema(db, [], { version: { table: "kit_schema", current: 1 } })).rejects.toThrow(
      /holds storage of version 2, newer than this FastAgent's 1/,
    );
  });

  it("splits multibyte UTF-8 text on character boundaries and rejects caps smaller than one character", () => {
    const text = "中文🚀边界".repeat(10);
    const parts = splitPgText(text, 10);
    expect(parts).toBeDefined();
    expect(parts?.every((p) => Buffer.byteLength(p, "utf8") <= 10)).toBe(true);
    expect(parts?.join("")).toBe(text);
    expect(splitPgText("ascii", 10)).toBeUndefined();
    expect(() => splitPgText("🚀", 2)).toThrow(/cannot hold one character/);
  });

  it("rolls back the lease row when onTake throws and leaves the instance immediately claimable", async () => {
    const db = openPgDatabase(postgres.url);
    try {
      await migratePgSchema(db, [
        "CREATE TABLE IF NOT EXISTS kit_test_leases (instance TEXT PRIMARY KEY, owner TEXT, lease_until TIMESTAMPTZ, handoff_requested_at TIMESTAMPTZ)",
      ]);
      const name = freshInstance();
      await expect(
        acquirePgInstanceLease(db, {
          table: "kit_test_leases",
          instance: name,
          waitMs: 0,
          onTake: async () => {
            throw new Error("rejected by onTake");
          },
        }),
      ).rejects.toThrow("rejected by onTake");

      const claimed = await acquirePgInstanceLease(db, {
        table: "kit_test_leases",
        instance: name,
        waitMs: 0,
      });
      await expect(
        acquirePgInstanceLease(db, { table: "kit_test_leases", instance: name, waitMs: 0 }),
      ).rejects.toBeInstanceOf(InstanceHeld);
      await claimed.release();
    } finally {
      await db.close();
    }
  });

  it("coalesces lease renewals on a SharedPostgresDatabase into one batched SQL query per tick", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const shared = openPostgresDatabase({ url: postgres.url }, { max: 4 });
    const handle = sharedHandleOf(shared)!;
    const origQuery = handle.borrowed.query.bind(handle.borrowed);
    let renewQueries = 0;
    let renewedMaxBatch = 0;
    (handle.borrowed as { query: PgDatabase["query"] }).query = async (text, params) => {
      if (text.includes("UPDATE durable_leases") && text.includes("unnest(")) {
        renewQueries += 1;
        const instances = Array.isArray(params?.[0]) ? params[0].length : 0;
        renewedMaxBatch = Math.max(renewedMaxBatch, instances);
      }
      return origQuery(text, params);
    };
    const storages: PostgresStorage[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        storages.push(await openPostgresStorage(shared, freshInstance()));
      }
      expect(renewQueries).toBe(0);
      await vi.advanceTimersByTimeAsync(8_000);
      await vi.waitFor(() => expect(renewQueries).toBe(1), { timeout: 5_000 });
      expect(renewedMaxBatch).toBe(5);
    } finally {
      await Promise.all(storages.map((s) => s.close(BACKGROUND_CONTEXT)));
      await shared.close();
      vi.useRealTimers();
    }
  });

  it("cooperatively hands off an idle lease without interrupting busy holders or zero-wait probes", async () => {
    const db = openPgDatabase(postgres.url);
    try {
      await migratePgSchema(db, [
        "CREATE TABLE IF NOT EXISTS kit_handoff_leases (instance TEXT PRIMARY KEY, owner TEXT, lease_until TIMESTAMPTZ, handoff_requested_at TIMESTAMPTZ)",
      ]);
      const name = freshInstance();
      let busy = true;
      let lostError: Error | undefined;
      let handedOff = false;
      let holder!: Awaited<ReturnType<typeof acquirePgInstanceLease>>;
      holder = await acquirePgInstanceLease(db, {
        table: "kit_handoff_leases",
        instance: name,
        leaseMs: 1_200,
        waitMs: 0,
        handoff: {
          canYield: () => !busy,
          onHandoff: () => {
            handedOff = true;
            void holder.release();
          },
        },
        onLost: (err) => {
          lostError = err;
        },
      });

      // A zero-wait probe fails immediately and never sets handoff_requested_at.
      await expect(
        acquirePgInstanceLease(db, { table: "kit_handoff_leases", instance: name, leaseMs: 1_200, waitMs: 0 }),
      ).rejects.toBeInstanceOf(InstanceHeld);
      const [probeRow] = await db.query<{ handoff_requested_at: Date | null }>(
        "SELECT handoff_requested_at FROM kit_handoff_leases WHERE instance = $1",
        [name],
      );
      expect(probeRow?.handoff_requested_at).toBeNull();

      // While busy === true, a waiting contender requests handoff but must NOT preempt the active holder.
      const contender = acquirePgInstanceLease(db, {
        table: "kit_handoff_leases",
        instance: name,
        leaseMs: 1_200,
        waitMs: 5_000,
      });
      await vi.waitFor(
        async () => {
          const [row] = await db.query<{ handoff_requested_at: Date | null }>(
            "SELECT handoff_requested_at FROM kit_handoff_leases WHERE instance = $1",
            [name],
          );
          expect(row?.handoff_requested_at).not.toBeNull();
        },
        { timeout: 3_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(handedOff).toBe(false);
      expect(lostError).toBeUndefined();

      // Once idle (busy = false), the holder yields via onHandoff (never onLost) and fences local writes.
      busy = false;
      const successor = await contender;
      expect(handedOff).toBe(true);
      expect(lostError).toBeUndefined();
      expect(holder.lost?.message).toMatch(/handed off while idle/);
      await successor.release();
      await holder.release();
    } finally {
      await db.close();
    }
  });

  it("hands off an idle pi-durable openAgent instance cooperatively to a successor process", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const shared = openPostgresDatabase({ url: postgres.url }, { max: 4 });
    let first: Awaited<ReturnType<typeof openSource>> | undefined;
    let second: Awaited<ReturnType<typeof openSource>> | undefined;
    try {
      const dir = await fauxAgent("fa-pg-handoff-");
      const name = freshInstance();
      let firstClosed = false;
      first = await openSource(dir, { name, database: shared });
      void first.closed?.then(() => {
        firstClosed = true;
      });
      const openingSecond = openSource(dir, {
        name,
        secrets: { ...process.env, FASTAGENT_DATABASE_URL: postgres.url },
      });
      await vi.waitFor(
        async () => {
          const db = openPgDatabase(postgres.url);
          try {
            const [row] = await db.query<{ handoff_requested_at: Date | null }>(
              "SELECT handoff_requested_at FROM durable_leases WHERE instance = $1",
              [name],
            );
            expect(row?.handoff_requested_at).not.toBeNull();
          } finally {
            await db.close();
          }
        },
        { timeout: 5_000 },
      );
      await vi.advanceTimersByTimeAsync(8_000);
      second = await openingSecond;
      await vi.waitFor(() => expect(firstClosed).toBe(true), { timeout: 5_000 });
      const session = await second.sessions.create();
      expect(
        (await second.messages.send({ sessionId: session.id, content: "after handoff" }, { wait: 15 })).status,
      ).toBe("completed");
    } finally {
      await second?.close();
      await first?.close();
      await shared.close();
      vi.useRealTimers();
    }
  });

  it("serializes same-process close() -> openAgent() handoff on a shared PostgreSQL pool", async () => {
    const shared = openPostgresDatabase({ url: postgres.url }, { max: 4 });
    let first: Awaited<ReturnType<typeof openSource>> | undefined;
    let second: Awaited<ReturnType<typeof openSource>> | undefined;
    try {
      const dir = await fauxAgent("fa-pg-reopen-");
      const name = freshInstance();
      first = await openSource(dir, { name, database: shared });
      const session = await first.sessions.create({ title: "before-close" });

      // Start closing without awaiting, then reopen immediately on the same shared pool and instance name.
      const closing = first.close();
      expect(first.ready()).toBe(false);
      second = await openSource(dir, { name, database: shared });
      await closing;

      expect(second.ready()).toBe(true);
      expect((await second.sessions.get(session.id)).title).toBe("before-close");
    } finally {
      await second?.close();
      await first?.close();
      await shared.close();
    }
  });
});
