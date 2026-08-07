import { readFileSync, readdirSync, writeFileSync } from "node:fs";
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
