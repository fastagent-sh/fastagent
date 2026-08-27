/**
 * The AgentSession L0's session store: pi accepts the ids channels actually mint, two rooms never
 * share a record, and a conversation started by the harness path is continued rather than restarted.
 */
import { writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  callerSessionId,
  piInMemorySessionRecordStore,
  piSessionId,
  piSessionRecordStore,
} from "../src/engines/pi/session-store.ts";

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
    // One conversation, one record - this engine keeps its own under a subdirectory of the store.
    expect((await SessionManager.list(cwd, join(dir, "agent-session"))).length).toBe(1);
  });

  it("does not hand a conversation the record another engine's spelling of its name produced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-store-collide-"));
    const cwd = process.cwd();
    const store = piSessionRecordStore({ dir, cwd });

    // The harness path stores raw ids, so a room literally called "s42" lands on disk as "s42" -
    // which is also what this store's encoding produces for the DIFFERENT room "42".
    writeFileSync(
      join(dir, "2026-01-01T00-00-00-000Z_s42.jsonl"),
      `${[
        { type: "session", version: 3, id: "s42", timestamp: "2026-01-01T00:00:00.000Z", cwd },
        {
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "belongs to room s42" },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    const other = await store.openOrCreate("42");

    expect(other.getBranch().some((e) => JSON.stringify(e).includes("belongs to room s42"))).toBe(false);
    // And the room that DOES own it still gets it.
    expect(
      (await store.openOrCreate("s42")).getBranch().some((e) => JSON.stringify(e).includes("belongs to room s42")),
    ).toBe(true);
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

describe("a relative dir belongs to the workspace, not to the process", () => {
  it("resolves against cwd, so a serving process that chdirs still finds its records", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fa-store-relative-"));
    const store = piSessionRecordStore({ dir: "sessions", cwd: workspace });

    const session = await store.openOrCreate("42");
    session.appendMessage({ role: "user", content: "relative", timestamp: 1 });

    // Under the workspace, not under whatever directory the test runner started in.
    expect(session.getSessionFile()).toContain(join(workspace, "sessions"));
    expect(
      (await piSessionRecordStore({ dir: "sessions", cwd: workspace }).openIfExists("42"))?.getBranch(),
    ).toHaveLength(1);
  });
});

describe("the lifecycle primitives (list / fork / delete)", () => {
  it("lists CALLER ids, not record names — the encoding is a storage detail, decoded back on the way out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-store-list-"));
    const store = piSessionRecordStore({ dir, cwd: dir });
    // A telegram group and a feishu thread: neither is a legal pi record name, which is the whole
    // reason the encoding exists — and exactly why a listing must not report what is on disk.
    for (const id of ["-1001234567890", "oc_9:thread/1"]) {
      (await store.openOrCreate(id)).appendMessage({ role: "user", content: "hi", timestamp: 1 });
    }
    const listed = await store.list();
    expect(listed.map((r) => r.session).sort()).toEqual(["-1001234567890", "oc_9:thread/1"]);
    expect(listed.every((r) => r.messageCount === 1 && r.createdAt > 0)).toBe(true);
  });

  it("round-trips every id shape the encoding escapes", () => {
    for (const id of ["42", "-1001234567890", "oc_9:thread/1", "a b", "emoji-🌤", "trailing-", "_", "s42"]) {
      expect(callerSessionId(piSessionId(id))).toBe(id);
    }
    // Not ours to decode: the older spelling and anything else are left out of a listing rather
    // than reported under a name no client could dial.
    expect(callerSessionId("%2Dweird")).toBeUndefined();
    expect(callerSessionId("s_ZZ")).toBeUndefined();
  });

  it("fork copies the history up to an entry; delete removes the record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-store-fork-"));
    const store = piSessionRecordStore({ dir, cwd: dir });
    const parent = await store.openOrCreate("room");
    parent.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const at = parent.appendMessage(fauxAssistantMessage("first answer"));
    parent.appendMessage({ role: "user", content: "second", timestamp: 3 });
    parent.appendMessage(fauxAssistantMessage("second answer"));

    await store.fork("room", at, "room-fork");
    const forked = await store.openIfExists("room-fork");
    expect(forked?.getBranch().length).toBe(2); // up to `at`, not the parent's leaf
    expect((await store.list()).map((r) => r.session).sort()).toEqual(["room", "room-fork"]);
    // The parent is untouched by its own fork.
    expect((await store.openIfExists("room"))?.getBranch().length).toBe(4);

    expect(await store.delete("room-fork")).toBe(true);
    expect(await store.openIfExists("room-fork")).toBeUndefined();
    expect(await store.delete("room-fork")).toBe(false); // gone is not an error, it is an answer
  });

  it("in memory too: same three primitives, same semantics", async () => {
    const store = piInMemorySessionRecordStore();
    const parent = await store.openOrCreate("room");
    const at = parent.appendMessage({ role: "user", content: "first", timestamp: 1 });
    parent.appendMessage({ role: "user", content: "second", timestamp: 2 });
    await store.fork("room", at, "copy");
    expect((await store.openIfExists("copy"))?.getBranch().length).toBe(1);
    expect((await store.list()).map((r) => r.session).sort()).toEqual(["copy", "room"]);
    expect(await store.delete("copy")).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });
});

describe("the lifecycle primitives: the failure modes each one owes", () => {
  it("a store that cannot be READ rejects — pi's own list() answers [] on any IO error", async () => {
    // Why this probe exists at all: `[]` is the honest answer for a deployment with no sessions, so
    // a swallowed fault would render as "no conversations" in a GUI — the conflation the coded 503
    // (sessions_unavailable) exists to prevent. Without the readdir probe this test goes green with
    // an empty array, which is exactly how the mechanism was dead on arrival.
    const dir = await mkdtemp(join(tmpdir(), "fa-store-unreadable-"));
    // A FILE where the records directory belongs: ENOTDIR reproduces on every platform and does not
    // depend on the test user's privileges (a root CI container ignores mode bits).
    await writeFile(join(dir, "agent-session"), "not a directory\n");
    await expect(piSessionRecordStore({ dir, cwd: dir }).list()).rejects.toThrow(/ENOTDIR/);
  });

  it("an empty session has NO preview — pi's placeholder is not something a user typed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-store-preview-"));
    const store = piSessionRecordStore({ dir, cwd: dir });
    await store.openOrCreate("fresh");
    expect((await store.list())[0]).toMatchObject({ session: "fresh", messageCount: 0 });
    expect((await store.list())[0]?.preview).toBeUndefined(); // not "(no messages)"
  });

  it("forking onto an existing session is refused by the STORE, in both backends", async () => {
    // The hub checks this too, but the port promises "a new record": a second caller (or two
    // concurrent forks) must not be able to replace a live conversation's history.
    const dir = await mkdtemp(join(tmpdir(), "fa-store-collide-"));
    const disk = piSessionRecordStore({ dir, cwd: dir });
    const memory = piInMemorySessionRecordStore();
    for (const store of [disk, memory]) {
      const parent = await store.openOrCreate("room");
      parent.appendMessage({ role: "user", content: "first", timestamp: 1 });
      const at = parent.appendMessage(fauxAssistantMessage("answer"));
      await store.openOrCreate("taken");
      await expect(store.fork("room", at, "taken")).rejects.toThrow(/already exists/);
      expect((await store.openIfExists("taken"))?.getBranch()).toHaveLength(0); // untouched
    }
  });

  it("a lifecycle fork keeps the whole copied history — the inheritance window is not its business", async () => {
    // A new THREAD gets a compaction mark bounding what its model sees. A fork is the same user
    // keeping their own history, so marking it would hide the exact entries they forked to keep.
    // Only visible past the window (50 exchanges), which is why the two backends drifted unnoticed.
    const store = piInMemorySessionRecordStore();
    const parent = await store.openOrCreate("long");
    let at = "";
    for (let i = 0; i < 60; i++) {
      parent.appendMessage({ role: "user", content: `q${i}`, timestamp: i });
      at = parent.appendMessage(fauxAssistantMessage(`a${i}`));
    }
    await store.fork("long", at, "long-fork");
    const child = await store.openIfExists("long-fork");
    expect(child?.getBranch().filter((e) => e.type === "compaction")).toHaveLength(0);
    // The inheritance path, same backend, DOES bound it — the split is deliberate, not an omission.
    const thread = await store.openOrCreate("thread", { parentSession: "long" });
    expect(thread.getBranch().filter((e) => e.type === "compaction").length).toBeGreaterThan(0);
  });

  it("a fork carries the source's name, on disk and in memory alike", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-store-forkname-"));
    for (const store of [piSessionRecordStore({ dir, cwd: dir }), piInMemorySessionRecordStore()]) {
      const parent = await store.openOrCreate("named");
      parent.appendSessionInfo("Deploy notes");
      parent.appendMessage({ role: "user", content: "first", timestamp: 1 });
      const at = parent.appendMessage(fauxAssistantMessage("answer"));
      await store.fork("named", at, "named-fork");
      // On disk the name cannot NOT travel (it is a record on the copied path); memory matches it
      // rather than being quietly different.
      expect((await store.openIfExists("named-fork"))?.getSessionName()).toBe("Deploy notes");
    }
  });
});

describe("fork: the copy is a copy", () => {
  it("forks at a USER entry — pi's file-level fork cannot, and the failure was permanent-but-retryable", async () => {
    // pi writes a branched file only once the copied path holds an assistant message, so the old
    // two-call fork handed `forkFrom` a path that did not exist. It surfaced as
    // boundary_command_failed{retryable: true} for a condition no retry can change, on the exact
    // entry a client forks from most: "start over from what I asked".
    const dir = await mkdtemp(join(tmpdir(), "fa-store-forkuser-"));
    for (const store of [piSessionRecordStore({ dir, cwd: dir }), piInMemorySessionRecordStore()]) {
      const parent = await store.openOrCreate("room");
      const at = parent.appendMessage({ role: "user", content: "the question", timestamp: 1 });
      parent.appendMessage(fauxAssistantMessage("an answer to discard"));

      await store.fork("room", at, "retry");
      const child = await store.openIfExists("retry");
      expect(child?.getBranch()).toHaveLength(1);
      expect(JSON.stringify(child?.getBranch())).toContain("the question");
      expect(JSON.stringify(child?.getBranch())).not.toContain("an answer to discard");
    }
  });

  it("never writes to the record it copies FROM", async () => {
    // The reconcile this used to run appends at the parent's LEAF — unreachable from a copy that
    // stops at `at`, so it repaired nothing and durably mutated the source: a "copy" bumping the
    // original's updatedAt and message count.
    const dir = await mkdtemp(join(tmpdir(), "fa-store-forkpure-"));
    const store = piSessionRecordStore({ dir, cwd: dir });
    const parent = await store.openOrCreate("room");
    parent.appendMessage({ role: "user", content: "run the tool", timestamp: 1 });
    const at = parent.appendMessage({
      ...fauxAssistantMessage(""),
      content: [{ type: "toolCall", id: "call-1", name: "doer", arguments: {} }],
      stopReason: "toolUse",
    } as never);

    const before = (await store.list()).find((r) => r.session === "room");
    await store.fork("room", at, "copy");
    const after = (await store.list()).find((r) => r.session === "room");
    expect(after?.messageCount).toBe(before?.messageCount); // the source is untouched by its own fork

    // The child's dangling tool call is repaired on its own first open, like any other record.
    const child = await store.openOrCreate("copy");
    expect(JSON.stringify(child.getBranch())).toContain("interrupted-tool-call");
  });

  it("a first message with no TEXT still has no preview — the count cannot tell", async () => {
    // A caption-less photo (telegram/feishu/slack open plenty of sessions this way): messageCount is
    // 1, and pi's firstMessage is its "(no messages)" sentinel.
    const dir = await mkdtemp(join(tmpdir(), "fa-store-imgpreview-"));
    const store = piSessionRecordStore({ dir, cwd: dir });
    const session = await store.openOrCreate("photo");
    session.appendMessage({
      role: "user",
      content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
      timestamp: 1,
    } as never);
    session.appendMessage(fauxAssistantMessage("nice picture"));

    const row = (await store.list()).find((r) => r.session === "photo");
    expect(row?.messageCount).toBeGreaterThan(0);
    expect(row?.preview).toBeUndefined();
  });
});

describe("list rows are safe to render", () => {
  it("truncates a preview by CODE POINT — never half an emoji", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-store-emoji-"));
    const store = piSessionRecordStore({ dir, cwd: dir });
    const session = await store.openOrCreate("emoji");
    // The astral character straddles the 200-char cut: a UTF-16 slice leaves a lone surrogate.
    session.appendMessage({ role: "user", content: `${"a".repeat(199)}🌤 tail`, timestamp: 1 });
    session.appendMessage(fauxAssistantMessage("ok"));

    const preview = (await store.list()).find((r) => r.session === "emoji")?.preview as string;
    expect(preview).toHaveLength(201); // 199 + the pair, as ONE code point sliced whole
    expect(preview.endsWith("🌤")).toBe(true);
    expect(preview).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling HIGH surrogate — a whole pair ends on a low one
  });
});
