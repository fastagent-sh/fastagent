import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type PgDatabase,
  openPgDatabase,
} from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/database.ts";
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
      "FASTAGENT_DATABASE_URL: an instance in a database is opened by its name, and none was given: set FASTAGENT_NAME (an app: openAgent's name)",
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
    void agent.harness.closed.then(() => {
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
