import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, type AgentEvent, SESSION_BUSY_CODE } from "../src/agent.ts";
import { type BusyRetry, invokeTurn } from "../src/channels/telegram/invoke-turn.ts";

/** A fake agent scripted per-invoke: call N yields script[N] (the last entry repeats). */
function scriptedAgent(script: AgentEvent[][]) {
  let calls = 0;
  const agent: Agent = {
    async *invoke() {
      const events = script[Math.min(calls++, script.length - 1)] ?? [];
      for (const e of events) yield e;
    },
  };
  return { agent, invokes: () => calls };
}

const busyEvent: AgentEvent = {
  type: "failed",
  details: "session busy: a turn is already in flight",
  retryable: true,
  code: SESSION_BUSY_CODE,
};
const ok: AgentEvent[] = [{ type: "text", delta: "answer" }, { type: "completed" }];

const FAST: BusyRetry = { delayMs: 10, maxWaitMs: 500 };
const noAttachments = { primary: {}, buffered: { files: [], images: [], skipped: 0 } };

async function run(agent: Agent, retry: BusyRetry = FAST): Promise<AgentEvent[]> {
  const transport = { api: "http://t.test", botToken: "B", chatId: 1, filesDir: await mkdtemp(join(tmpdir(), "fa-")) };
  const out: AgentEvent[] = [];
  for await (const e of invokeTurn(agent, "s", "hi", transport, noAttachments, undefined, retry)) out.push(e);
  return out;
}

describe("invokeTurn busy-wait (the reverse of the scheduler's wake defer)", () => {
  it("a fail-fast busy reject retries (bounded) and the user gets the ANSWER, not an error", async () => {
    // Invoke 1: busy (an external wake turn holds the lease). Invoke 2: the lease freed — normal turn.
    const { agent, invokes } = scriptedAgent([[busyEvent], ok]);
    const events = await run(agent);
    expect(invokes()).toBe(2); // waited + re-invoked
    expect(events.map((e) => e.type)).toEqual(["text", "completed"]); // the busy failure never surfaced
  });

  it("an exhausted busy wait surfaces the busy failure (bounded, not forever)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, invokes } = scriptedAgent([[busyEvent]]); // always busy
    const events = await run(agent, { delayMs: 20, maxWaitMs: 100 });
    expect(events.at(-1)).toMatchObject({ type: "failed", code: SESSION_BUSY_CODE }); // surfaced after the wait
    expect(invokes()).toBeGreaterThan(1); // it did retry before giving up
    expect(invokes()).toBeLessThan(10); // …boundedly
    vi.restoreAllMocks();
  });

  it("a non-busy failure is yielded immediately — no retry (side effects may have run)", async () => {
    const failed: AgentEvent = { type: "failed", details: "provider 500", retryable: true };
    const { agent, invokes } = scriptedAgent([[failed]]);
    const events = await run(agent);
    expect(invokes()).toBe(1);
    expect(events).toEqual([failed]);
  });

  it("a busy event AFTER the first is passed through, never retried (the turn already started)", async () => {
    const { agent, invokes } = scriptedAgent([[{ type: "text", delta: "partial" }, busyEvent]]);
    const events = await run(agent);
    expect(invokes()).toBe(1); // no re-run of a started turn
    expect(events.map((e) => e.type)).toEqual(["text", "failed"]);
  });
});
