/**
 * The storage on a live Aurora DSQL cluster, signed in with this machine's AWS credentials: what PGlite and a plain
 * PostgreSQL cannot show. DSQL takes the tables and their indexes as `@fastagent-sh/agentcore` makes them, holds
 * pi-durable's storage contract, and the caps the package sets keep a commit, a value and a message within what DSQL
 * accepts. Outside the test suite, which leaves no test a way off the machine: run by hand, against a cluster of yours,
 * when the storage or the DSQL options change.
 *
 *   node --conditions=@fastagent-sh/source test/smoke/dsql/live.ts <cluster id>.dsql.<region>.on.aws
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { dsqlDatabase } from "../../../packages/agentcore/src/index.ts";
import { openAgent } from "../../../packages/fastagent/src/harnesses/serving.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/pi-durable/open.ts";
import { openPostgresStorage } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/storage.ts";
import { fauxAgent } from "../../doubles/cli-run.ts";

const endpoint = process.argv[2];
if (endpoint === undefined) throw new Error("usage: node test/smoke/dsql/live.ts <cluster id>.dsql.<region>.on.aws");
process.env.FASTAGENT_OFFLINE = "1";

const database = dsqlDatabase({ endpoint });
const instance = () => `live-${crypto.randomUUID()}`;
const open = (name = instance()) => {
  const { url, ...reached } = database;
  return openPostgresStorage(url, name, reached);
};

async function step(what: string, run: () => Promise<void>): Promise<void> {
  const started = performance.now();
  await run();
  console.error(`ok  ${what} (${((performance.now() - started) / 1000).toFixed(1)}s)`);
}

await step("many records in one commit, past a transaction's 3,000 rows, and a value past 1 MiB", async () => {
  const storage = await open();
  try {
    const conversationId = await storage.mintId();
    const writes: StorageWrite[] = [{ type: "conversation", value: { id: conversationId } } as unknown as StorageWrite];
    for (let i = 0; i < 1_600; i++) {
      const id = await storage.mintId();
      writes.push({
        type: "entry",
        value: { id, conversationId, type: "message", text: `n${i}` },
      } as unknown as StorageWrite);
    }
    const batches = writes.map((write) => [write]);
    assert.deepEqual(await storage.commit(batches, () => {}, BACKGROUND_CONTEXT), { stored: batches.length });
    // Random, so nothing compresses it below DSQL's 1 MiB a value.
    const text = randomBytes(2_400_000).toString("base64");
    const big = await storage.mintId();
    const write = { type: "conversation", value: { id: big, text } } as unknown as StorageWrite;
    assert.deepEqual(await storage.commit([[write]], () => {}, BACKGROUND_CONTEXT), { stored: 1 });
    assert.deepEqual(await storage.conversation(big as never, BACKGROUND_CONTEXT), { id: big, text });
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
});

await step("an app's agent answers on it, and refuses a message larger than a transaction keeps", async () => {
  const dir = await fauxAgent("fa-dsql-");
  const agent = await openAgent(await loadSourceDefinition(dir), {
    root: dir,
    name: instance(),
    database,
    offline: true,
  });
  try {
    const { id: sessionId } = await agent.sessions.create();
    await assert.rejects(agent.messages.send({ sessionId, content: "x".repeat(7 * 1024 * 1024) }), {
      code: "invalid_request",
      details: { reason: "too_large" },
    });
    const answered = await agent.messages.send({ sessionId, content: "hello" }, { wait: 120 });
    assert.deepEqual([answered.status, answered.answer?.text], ["completed", "seen 1"]);
  } finally {
    await agent.close();
  }
});

const assertions = {
  ok: (value: unknown, message?: string) => assert.ok(value, message ?? "expected a truthy value"),
  strictEqual: (actual: unknown, expected: unknown) => assert.strictEqual(actual, expected),
  deepEqual: (actual: unknown, expected: unknown) => assert.deepStrictEqual(actual, expected),
  partialDeepEqual: (actual: unknown, expected: unknown) => assert.partialDeepStrictEqual(actual, expected),
  greaterThan: (actual: number, expected: number) => assert.ok(actual > expected, `expected ${actual} > ${expected}`),
  rejects: (operation: Promise<unknown>, messageIncludes: string) =>
    assert.rejects(operation, (error: unknown) => String((error as Error)?.message ?? error).includes(messageIncludes)),
};
const cases = createStorageConformance({
  assertions,
  withStorage: async (use) => {
    const storage = await open();
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
});
for (const testCase of cases) await step(`storage contract: ${testCase.name}`, () => testCase.run());
console.error(`ok  all on ${endpoint}`);
