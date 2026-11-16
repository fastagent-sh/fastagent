/**
 * The PostgreSQL double against a real server, `FASTAGENT_TEST_POSTGRES_URL` (CI runs one; locally, any server you may
 * make databases on): pi-durable's storage contract holds on the server too, and the server answers what the unit
 * tests rely on as the double does. What only a server of many backends can show is tested here alone: two instances
 * making the tables of a new database at once.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPgDatabase } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/database.ts";
import { migrate } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/schema.ts";
import {
  PostgresStorage,
  openPostgresStorage,
} from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/storage.ts";
import { type ServedPostgres, freshInstance, servedPostgres } from "../../doubles/postgres-double.ts";

const SERVER = process.env.FASTAGENT_TEST_POSTGRES_URL;

it("has a server to compare with in CI", () => {
  if (process.env.CI !== undefined) expect(SERVER, "set FASTAGENT_TEST_POSTGRES_URL").toBeDefined();
});

/** A new database on the server, dropped after the file: each run starts from no tables. */
async function freshDatabase(server: string): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `fastagent_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = openPgDatabase(server);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.close();
  const url = new URL(server);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const admin = openPgDatabase(server);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

async function newConversation(storage: Storage): Promise<number> {
  const id = await storage.mintId();
  const write = { type: "conversation", value: { id } } as unknown as StorageWrite;
  await storage.commit([[write]], () => {}, BACKGROUND_CONTEXT);
  return id;
}

/** What one process sees of another that holds, then stalls past, the instance's lease. */
async function leaseOutcomes(url: string) {
  const instance = freshInstance();
  const open = async (waitMs: number) => {
    const db = openPgDatabase(url);
    await migrate(db);
    return PostgresStorage.open(db, instance, { lease: { leaseMs: 60_000, waitMs }, holders: "the other" }).catch(
      async (error: unknown) => {
        await db.close();
        throw error;
      },
    );
  };
  const settle = (promise: Promise<unknown>) =>
    promise.then(
      () => "ok",
      (error: Error) => error.message.replace(instance, "<instance>").replace(/until \S+:/, "until <time>:"),
    );
  const first = await open(0);
  await newConversation(first);
  const refused = await settle(open(0));
  const db = openPgDatabase(url);
  await db.query("UPDATE durable_leases SET lease_until = now() - interval '1 second' WHERE instance = $1", [instance]);
  await db.close();
  const successor = await open(0);
  const fenced = await settle(newConversation(first));
  const successorWrites = await settle(newConversation(successor));
  await successor.close(BACKGROUND_CONTEXT);
  await first.close(BACKGROUND_CONTEXT);
  return { refused, fenced, successorWrites };
}

describe.runIf(SERVER !== undefined)("PostgreSQL, the double against a real server", () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>;
  let double: ServedPostgres;
  beforeAll(async () => {
    database = await freshDatabase(SERVER as string);
    double = await servedPostgres();
  });
  afterAll(async () => {
    await double.close();
    await database.drop();
  });

  registerStorageConformance({ describe, expect, it }, "pi-durable's storage contract, on the server", async (use) => {
    const storage = await openPostgresStorage(database.url, freshInstance());
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  });

  it("holds and hands over an instance's lease as the double does", async () => {
    const real = await leaseOutcomes(database.url);
    expect(real).toEqual({
      refused:
        'the instance "<instance>" is held by another process until <time>: the other is running. Stop that one first',
      fenced: 'the instance "<instance>" was taken over by another process',
      successorWrites: "ok",
    });
    expect(await leaseOutcomes(double.url)).toEqual(real);
  });

  it("makes the tables of a new database once when two instances open it together", async () => {
    const fresh = await freshDatabase(SERVER as string);
    try {
      const opened = await Promise.all(
        Array.from({ length: 4 }, () => openPostgresStorage(fresh.url, freshInstance())),
      );
      await Promise.all(opened.map((storage) => storage.close(BACKGROUND_CONTEXT)));
    } finally {
      await fresh.drop();
    }
  });
});
