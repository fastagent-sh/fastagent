import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { feishuEnvelope } from "../src/channels/feishu/parse.ts";
import { inMemorySessionStore, jsonlSessionStore, type PiSessionStore } from "../src/engines/pi/sessions.ts";
import { makeFaux } from "./faux.ts";

// Session inheritance (participant-model.md §5: "a thread starts from what the room knew"): a NEW
// session that names a parent forks it ONCE — at the branch point when a hint locates one — and a
// mechanical compaction mark bounds what the model sees. Every edge fails toward an empty session
// with a warn: context is not the ask, and a thread must not lose its first turn to it.

const um = (text: string): AgentMessage =>
  ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }) as AgentMessage;
const am = (text: string): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() }) as AgentMessage;

/** What the MODEL would see, as one searchable string. */
async function contextText(session: Session): Promise<string> {
  return JSON.stringify((await session.buildContext()).messages);
}

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "fa-inherit-"));
  return { dir, store: jsonlSessionStore({ dir }) };
}

/** A parent with `n` exchanges: "q<i> ask" / "a<i> answer" (space-delimited — "q5 ask" never matches "q55 ask"). */
async function buildParent(store: PiSessionStore, id: string, n: number): Promise<Session> {
  const parent = await store.openOrCreate(id);
  for (let i = 1; i <= n; i++) {
    await parent.appendMessage(um(`q${i} ask`));
    await parent.appendMessage(am(`a${i} answer`));
  }
  return parent;
}

describe("session inheritance (fork-on-first-open)", () => {
  it("a new session naming a parent forks it once, then lives independently", async () => {
    const { store } = await freshStore();
    const parent = await buildParent(store, "room", 2);

    const child = await store.openOrCreate("thread", { parentSession: "room" });
    const seen = await contextText(child);
    expect(seen).toContain("q1 ask");
    expect(seen).toContain("a2 answer");

    // Independence, both directions: later parent writes are invisible to the child, and the
    // child's writes never reach the parent.
    await parent.appendMessage(um("q3 after the fork"));
    await child.appendMessage(um("child-only note"));
    const reopened = await store.openOrCreate("thread", { parentSession: "room" });
    const again = await contextText(reopened);
    expect(again).toContain("child-only note");
    expect(again).not.toContain("after the fork");
    expect(await contextText(await store.openOrCreate("room"))).not.toContain("child-only note");
  });

  it("an existing session ignores inherit entirely — one-time by construction", async () => {
    const { store } = await freshStore();
    await buildParent(store, "room", 1);
    const plain = await store.openOrCreate("thread"); // born WITHOUT a parent
    await plain.appendMessage(um("born empty"));

    const reopened = await store.openOrCreate("thread", { parentSession: "room" });
    const seen = await contextText(reopened);
    expect(seen).toContain("born empty");
    expect(seen).not.toContain("q1 ask"); // no retroactive inheritance
  });

  it("a missing parent starts the child empty instead of failing the turn", async () => {
    const { store } = await freshStore();
    const child = await store.openOrCreate("thread", { parentSession: "ghost" });
    expect(await child.getEntries()).toHaveLength(0);
  });

  it("a RELATIVE dir is resolved like pi resolves it — against the store's cwd, not process.cwd()", async () => {
    // pi's NodeExecutionEnv resolves a relative sessionsRoot against the store's `cwd`, while every
    // direct fs call here (mkdir/rename/stat) resolves against process.cwd(). Publishing off the raw
    // option would build a second, undiscoverable session tree beside the one pi reads — the child
    // would vanish from `list({ cwd })`, and "the session exists" would stop being the record that
    // inheritance already ran.
    const workspace = await mkdtemp(join(tmpdir(), "fa-rel-cwd-"));
    const store = jsonlSessionStore({ dir: ".state/sessions", cwd: workspace });
    await buildParent(store, "room", 2);
    const child = await store.openOrCreate("thread", { parentSession: "room" });
    expect(await contextText(child)).toContain("a2 answer");

    // Discoverable by the store's own lookup, and living under the workspace — not under the
    // process's cwd, where a raw relative join would have put it.
    expect(await store.openIfExists("thread")).toBeDefined();
    expect(existsSync(join(workspace, ".state", "sessions"))).toBe(true);
  });

  it("a branch hint picks the fork point — extended to the end of its exchange", async () => {
    const { store } = await freshStore();
    const parent = await store.openOrCreate("room");
    await parent.appendMessage(um("q1 about (msg om_A)"));
    await parent.appendMessage(am("a1 answer"));
    await parent.appendMessage(um("q2 about (msg om_B)"));
    await parent.appendMessage(am("a2 the branched-from answer"));
    await parent.appendMessage(um("q3 unrelated later talk"));
    await parent.appendMessage(am("a3 later answer"));

    const child = await store.openOrCreate("thread", { parentSession: "room", branchHints: ["om_B"] });
    const seen = await contextText(child);
    expect(seen).toContain("a2 the branched-from answer"); // the ANSWER of the hinted exchange rides along
    expect(seen).not.toContain("q3 unrelated"); // nothing after the branch point
  });

  it("the REAL feishu envelope carries the id the hints search for — no hand-written markers", async () => {
    // The whole hint mechanism stands on one fact: a summoning message's own id enters the parent
    // session via the prompt envelope. This test builds the parent text with the actual envelope
    // (channel code, not a test-crafted string), so if the envelope ever drops the id, THIS fails —
    // not just the field.
    const { store } = await freshStore();
    const parent = await store.openOrCreate("room");
    const envelope = feishuEnvelope({
      sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
      message: { message_id: "om_real_ask", chat_id: "oc_1", chat_type: "group", message_type: "text", content: "{}" },
    } as never);
    await parent.appendMessage(um(`${envelope}\n加一个足球页面`));
    await parent.appendMessage(am("a1 方案如下"));
    await parent.appendMessage(um("q2 later unrelated"));
    await parent.appendMessage(am("a2 later answer"));

    // The thread's hints: the card id (never in any session — sent after its turn) then the ask.
    const child = await store.openOrCreate("thread", {
      parentSession: "room",
      branchHints: ["om_bot_card_unfindable", "om_real_ask"],
    });
    const seen = await contextText(child);
    expect(seen).toContain("a1 方案如下"); // fork landed at the hinted exchange…
    expect(seen).not.toContain("later unrelated"); // …not at the leaf
  });

  it("no hint match inherits the parent's present, not nothing", async () => {
    const { store } = await freshStore();
    await buildParent(store, "room", 3);
    const child = await store.openOrCreate("thread", { parentSession: "room", branchHints: ["om_nowhere"] });
    expect(await contextText(child)).toContain("a3 answer"); // fell back to the leaf
  });

  it("the window keeps the newest 50 exchanges and says what it cut", async () => {
    const { store } = await freshStore();
    await buildParent(store, "room", 55);
    const child = await store.openOrCreate("thread", { parentSession: "room" });
    const { messages } = await child.buildContext();
    const seen = JSON.stringify(messages);
    expect(seen).toContain("5 earlier exchange(s) are not shown");
    expect(seen).toContain("q6 ask"); // the oldest kept exchange
    expect(seen).not.toContain("q5 ask"); // the newest elided one
    expect(messages).toHaveLength(1 + 50 * 2); // the mark's summary + 50 whole exchanges
  });

  it("the token budget cuts deeper than the exchange count when exchanges are heavy", async () => {
    const { store } = await freshStore();
    const parent = await store.openOrCreate("room");
    for (let i = 1; i <= 10; i++) {
      await parent.appendMessage(um(`q${i} ${"x".repeat(30_000)}`)); // ≈7.5K tokens each
      await parent.appendMessage(am(`a${i} short`));
    }
    const child = await store.openOrCreate("thread", { parentSession: "room" });
    const seen = await contextText(child);
    // 6 exchanges ≈45K fits the 50K budget; a 7th would not.
    expect(seen).toContain("4 earlier exchange(s) are not shown");
    expect(seen).toContain("a5 short");
    expect(seen).not.toContain("a4 short");
  });

  it("images are priced flat — one photo's base64 must not evict the text window", async () => {
    const { store } = await freshStore();
    const parent = await store.openOrCreate("room");
    await parent.appendMessage(um("q1 look at this"));
    await parent.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "q2 the photo" },
        { type: "image", data: "A".repeat(400_000), mimeType: "image/png" }, // ≈100K "tokens" if mispriced by chars
      ],
      timestamp: Date.now(),
    } as AgentMessage);
    await parent.appendMessage(am("a2 nice photo"));
    const child = await store.openOrCreate("thread", { parentSession: "room" });
    const seen = await contextText(child);
    expect(seen).not.toContain("earlier exchange(s) are not shown"); // flat pricing: everything fits
    expect(seen).toContain("q1 look at this");
    expect(seen).toContain('"type":"image"'); // the image itself rides the fork
  });

  it("a dangling tool call at the parent's leaf is repaired in the child", async () => {
    // Forking WHILE the parent is mid-turn captures an assistant tool_use with no result — the same
    // shape a crash leaves. Without repair, the child's first turn hands the provider an invalid
    // transcript.
    const { store } = await freshStore();
    const parent = await store.openOrCreate("room");
    await parent.appendMessage(um("q1 run the tool"));
    await parent.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "exec", arguments: {} }],
      stopReason: "toolUse",
      timestamp: Date.now(),
    } as AgentMessage);

    const child = await store.openOrCreate("thread", { parentSession: "room" });
    const { messages } = await child.buildContext();
    expect(messages.at(-1)?.role).toBe("toolResult"); // synthetic "interrupted" result closes the pair
  });

  it("a torn parent journal falls back to an empty child, never a thrown first turn", async () => {
    const { dir, store } = await freshStore();
    await buildParent(store, "room", 2);
    // Tear the last line mid-write, the way a fork racing the parent's own append would read it.
    const sessionDir = readdirSync(dir).map((d) => join(dir, d))[0] as string;
    const file = readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(sessionDir, f))[0] as string;
    const whole = readFileSync(file, "utf8");
    writeFileSync(file, whole.slice(0, whole.length - 20));

    const child = await store.openOrCreate("thread", { parentSession: "room" });
    expect(await child.getEntries()).toHaveLength(0);
  });

  it("a crashed draft cannot poison the store — drafts live outside every lookup", async () => {
    // Simulates a crash mid-inheritance: garbage under `.inherit-tmp` (where drafts are forked)
    // must be invisible — openIfExists finds nothing, and the next inheritance attempt runs afresh
    // and publishes a complete child. Exactly ONE file under the real directory afterwards.
    const { dir, store } = await freshStore();
    await buildParent(store, "room", 2);
    const realCwdDir = readdirSync(dir)
      .filter((d) => d !== ".inherit-tmp")
      .map((d) => join(dir, d))[0] as string;
    const tmpCwdDir = join(dir, ".inherit-tmp", realCwdDir.split("/").at(-1) as string);
    mkdirSync(tmpCwdDir, { recursive: true });
    writeFileSync(join(tmpCwdDir, "2020-01-01T00-00-00-000Z_thread.jsonl"), "{torn garbage");

    expect(await store.openIfExists("thread")).toBeUndefined(); // the draft realm is not discoverable
    const child = await store.openOrCreate("thread", { parentSession: "room" });
    expect(await contextText(child)).toContain("a2 answer"); // inheritance ran to completion
    const published = readdirSync(realCwdDir).filter((f) => f.endsWith("_thread.jsonl"));
    expect(published).toHaveLength(1); // one atomic publish, no duplicates
  });

  it("a failed inheritance leaves exactly one file — the empty fallback, never a half-child", async () => {
    const { dir, store } = await freshStore();
    await buildParent(store, "room", 2);
    const realCwdDir = readdirSync(dir)
      .filter((d) => d !== ".inherit-tmp")
      .map((d) => join(dir, d))[0] as string;
    // Tear the parent so the fork's read throws mid-inheritance.
    const parentFile = readdirSync(realCwdDir)
      .filter((f) => f.includes("_room"))
      .map((f) => join(realCwdDir, f))[0] as string;
    const whole = readFileSync(parentFile, "utf8");
    writeFileSync(parentFile, whole.slice(0, whole.length - 20));

    const child = await store.openOrCreate("thread", { parentSession: "room" });
    expect(await child.getEntries()).toHaveLength(0);
    const files = readdirSync(realCwdDir).filter((f) => f.endsWith("_thread.jsonl"));
    expect(files).toHaveLength(1);
  });

  it("branch hints are capped — ids, not payloads", async () => {
    const { store } = await freshStore();
    const parent = await store.openOrCreate("room");
    await parent.appendMessage(um(`q1 wall ${"L".repeat(300)}`));
    await parent.appendMessage(am("a1 the early answer"));
    await parent.appendMessage(um("q2 about (msg om_target)"));
    await parent.appendMessage(am("a2 the hinted answer"));
    await parent.appendMessage(um("q3 later"));
    await parent.appendMessage(am("a3 the leaf answer"));

    // An over-long "hint" (a payload, not an id) WOULD match the wall-of-text message — the length
    // cap must drop it BEFORE it scans. And a matching id sitting beyond the 16-hint cap is ignored
    // too. Both dropped → leaf fallback.
    const child = await store.openOrCreate("thread", {
      parentSession: "room",
      branchHints: ["L".repeat(200), ...Array.from({ length: 16 }, (_, i) => `om_nope_${i}`), "om_target"],
    });
    const seen = await contextText(child);
    expect(seen).toContain("a3 the leaf answer"); // fell back to the present
    expect(seen).toContain("a1 the early answer"); // …which includes everything (no early-fork cut)
  });

  it("a parent compaction's summary charges the window budget — it reaches the model too", async () => {
    // The scan starts BELOW the parent's last compaction, but that compaction's summary (and
    // retained tail) still enter the child's model context. Estimating them as zero would over-admit:
    // here the summary alone is ~40K of the 50K budget, so only the newest heavy exchange fits.
    const { store } = await freshStore();
    const parent = await store.openOrCreate("room");
    await parent.appendMessage(um("q0 pre-compaction"));
    await parent.appendMessage(am("a0 pre-compaction"));
    await parent.appendCompaction(`ROOM SUMMARY ${"S".repeat(160_000)}`, undefined, 99_000);
    for (let i = 1; i <= 5; i++) {
      await parent.appendMessage(um(`q${i} ${"x".repeat(30_000)}`)); // ≈7.5K tokens each
      await parent.appendMessage(am(`a${i} short`));
    }
    const child = await store.openOrCreate("thread", { parentSession: "room" });
    const seen = await contextText(child);
    expect(seen).toContain("4 earlier exchange(s) are not shown"); // only the newest exchange fit
    expect(seen).toContain("a5 short");
    expect(seen).not.toContain("a4 short");
  });

  it("an oversize parent is skipped — inheriting nothing beats stalling the first turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-inherit-"));
    const store = jsonlSessionStore({ dir, forkMaxBytes: 1_000 });
    await buildParent(store, "room", 5); // a few KB of journal
    const child = await store.openOrCreate("thread", { parentSession: "room" });
    expect(await child.getEntries()).toHaveLength(0);
  });

  it("the in-memory backend inherits the same way", async () => {
    const store = inMemorySessionStore();
    await buildParent(store, "room", 2);
    const child = await store.openOrCreate("thread", { parentSession: "room" });
    expect(await contextText(child)).toContain("a2 answer");
    const plainAgain = await store.openOrCreate("thread", { parentSession: "room" });
    await plainAgain.appendMessage(um("child note"));
    expect(await contextText(await store.openOrCreate("room"))).not.toContain("child note");
  });

  it("scope.parentSession flows through invoke into the store's create path", async () => {
    // End-to-end: the channel sets two Scope fields; the engine's first turn on the new session
    // already SEES the parent's exchange — proof the factory → store plumbing carries the extension.
    const { store } = await freshStore();
    await buildParent(store, "room", 1);
    const { faux, models } = makeFaux();
    let modelSaw: unknown;
    faux.setResponses([
      (context) => {
        modelSaw = context.messages;
        return fauxAssistantMessage("inherited fine");
      },
    ]);
    const agent = createPiAgentFromHarness({
      harnessFactory: piHarnessFactory({
        env: new NodeExecutionEnv({ cwd: process.cwd() }),
        sessions: store,
        models,
        model: faux.getModel(),
        systemPrompt: "test",
      }),
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.invoke(
      { session: "thread", parentSession: "room", branchHints: ["om_none"] },
      { text: "so, about that" },
    )) {
      events.push(e);
    }
    expect(events.at(-1)?.type).toBe("completed");
    const dump = JSON.stringify(modelSaw);
    expect(dump).toContain("q1 ask"); // the parent's exchange reached the model on turn ONE
    expect(dump).toContain("so, about that");
  });
});
