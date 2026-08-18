/**
 * The AgentSession L0's session store: pi accepts the ids channels actually mint, two rooms never
 * share a record, and a conversation started by the harness path is continued rather than restarted.
 */
import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { piInMemorySessionRecordStore, piSessionId, piSessionRecordStore } from "../src/engines/pi/session-store.ts";

/** What the built-in channels and a custom route() produce. */
const CHANNEL_IDS = [
  "-1001234567890", // telegram group
  "42", // telegram 1:1
  "feishu:oc_a1b2/thread=om_x9",
  "slack:T01/C02/1699999999.000100",
  "github:owner/repo#12",
  "schedule:nightly-digest",
  "中文房间",
  "trailing-",
  "trailing.",
  "_leading",
];

describe("piSessionId", () => {
  it("every id a channel can mint becomes a name pi accepts", () => {
    // pi's own rule, restated: SessionManager.create throws on anything else, and every built-in
    // channel violates it (a telegram group id leads with a dash; feishu and slack keys carry : and /).
    const PI_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
    for (const id of CHANNEL_IDS) {
      expect(piSessionId(id)).toMatch(PI_SESSION_ID);
      expect(() => SessionManager.inMemory(process.cwd(), { id: piSessionId(id) })).not.toThrow();
    }
  });

  it("is injective — no two conversations can resolve to one record", () => {
    // The pairs that a careless encoding collapses: escape-vs-literal, and the conditional-prefix trap.
    const ids = [...CHANNEL_IDS, "-a", "s-a", "a_2D", "a-", "a.", "a", "_", "__", "%2D", "-1001234567890 "];
    const encoded = ids.map(piSessionId);
    expect(new Set(encoded).size).toBe(ids.length);
  });

  it("stays readable for the ids an operator reads off disk", () => {
    expect(piSessionId("-1001234567890")).toBe("s-1001234567890");
    expect(piSessionId("42")).toBe("s42");
  });
});

describe("piSessionRecordStore", () => {
  it("open-or-create: the same id continues its record, a different one gets its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-store-"));
    const store = piSessionRecordStore({ dir });

    const first = await store.openOrCreate("-1001234567890");
    first.appendMessage({ role: "user", content: "remember me", timestamp: Date.now() });

    const again = await store.openOrCreate("-1001234567890");
    expect(again.getBranch().some((e) => JSON.stringify(e).includes("remember me"))).toBe(true);

    const other = await store.openOrCreate("feishu:oc_a1b2/thread=om_x9");
    expect(other.getBranch().some((e) => JSON.stringify(e).includes("remember me"))).toBe(false);
  });

  it("the question survives a crash before the answer — and open-or-create stays idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-store-crash-"));
    const cwd = process.cwd();
    // pi buffers a NEW session until its first ASSISTANT message, so without the store's own publish
    // step nothing exists on disk yet at this point - the user's question would die with the process,
    // and a second open-or-create would fork a second file for the same conversation.
    const asked = await piSessionRecordStore({ dir, cwd }).openOrCreate("42");
    asked.appendMessage({ role: "user", content: "what did I ask?", timestamp: Date.now() });

    // A different process, same directory: nothing shared but the disk.
    const after = await piSessionRecordStore({ dir, cwd }).openOrCreate("42");

    expect(after.getBranch().some((e) => JSON.stringify(e).includes("what did I ask?"))).toBe(true);
    expect((await SessionManager.list(cwd, dir)).length).toBe(1); // one conversation, one record
  });

  it("continues a record the harness path wrote, instead of restarting the conversation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-store-legacy-"));
    const cwd = process.cwd();
    // Written the way the harness path writes it: sessions.ts keeps `[A-Za-z0-9._-]` verbatim, so a
    // telegram group id lands on disk AS the id - a spelling pi itself refuses to mint, which is why
    // this record has to be laid down by hand rather than through SessionManager.
    const id = "-1001234567890";
    writeFileSync(
      join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
      `${[
        { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
        {
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "written by the harness path" },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    const reopened = await piSessionRecordStore({ dir, cwd }).openOrCreate(id);

    expect(reopened.getBranch().some((e) => JSON.stringify(e).includes("written by the harness path"))).toBe(true);
  });
});

describe("piInMemorySessionRecordStore", () => {
  it("continuity within the instance, and none across ids", async () => {
    const store = piInMemorySessionRecordStore();
    const a = await store.openOrCreate("room-1");
    a.appendMessage({ role: "user", content: "in memory", timestamp: Date.now() });
    expect((await store.openOrCreate("room-1")).getBranch().length).toBe(1);
    expect((await store.openOrCreate("room-2")).getBranch().length).toBe(0);
  });
});
