import { describe, expect, it } from "vitest";
import type { ContextBuffer } from "../src/channels/kit/context-buffer.ts";
import { createTurnRunner } from "../src/channels/kit/turn-runner.ts";
import type { TurnRecordBase, TurnStore } from "../src/channels/kit/turn-store.ts";

interface Stored extends TurnRecordBase {
  text: string;
}
interface Pending extends Omit<Stored, "attempts"> {
  notice?: string;
}

/** A store that records what the runner asks of it, with a scripted answer per attempt. */
function fakeStore(decisions: Record<string, "run" | "exceeded" | "defer"> = {}) {
  const calls: string[] = [];
  const recovered: Stored[] = [];
  const store: TurnStore<Stored> = {
    add: (rec) => {
      calls.push(`add ${rec.id}`);
    },
    remove: (id) => {
      calls.push(`remove ${id}`);
    },
    recover: () => recovered,
    startAttempt: (id) => {
      calls.push(`attempt ${id}`);
      return decisions[id] ?? "run";
    },
  };
  return { store, calls, recovered };
}

function fakeBuffer(calls: string[]): ContextBuffer<string> {
  return {
    push: () => {},
    peek: (key) => {
      calls.push(`peek ${key}`);
      return { text: "earlier", consumed: ["e1"] };
    },
    commit: (key, consumed) => {
      calls.push(`commit ${key} ${consumed.join(",")}`);
    },
  } as unknown as ContextBuffer<string>;
}

function runner(
  store: TurnStore<Stored>,
  calls: string[],
  overrides: Partial<Parameters<typeof createTurnRunner<Pending, Stored, string>>[0]> = {},
) {
  return createTurnRunner<Pending, Stored, string>({
    label: "[t]",
    store,
    buffer: fakeBuffer(calls),
    seen: { add: (id) => calls.push(`seen ${id}`) },
    toStored: ({ notice: _n, ...intent }) => ({ ...intent, attempts: 0 }),
    fromStored: ({ attempts: _a, ...intent }) => ({ ...intent, notice: undefined }),
    bufferKey: (rec) => `place:${rec.session}`,
    where: (rec) => `session=${rec.session}`,
    onDeferred: (rec) => calls.push(`deferred ${rec.id}`),
    notifyDropped: (rec) => calls.push(`dropped ${rec.id}`),
    execute: async (rec, discussion, onCompleted) => {
      calls.push(`execute ${rec.id} notice=${rec.notice ?? "-"} text=${discussion.text}`);
      onCompleted();
    },
    ...overrides,
  });
}

describe("turn runner: the lifecycle order every chat channel shares", () => {
  it("accepts, settles the queue notice, counts the attempt, folds, executes, commits, and drops the intent", async () => {
    const { store, calls } = fakeStore();
    const r = runner(store, calls, {
      onQueuedBehind: (rec) => ({
        done: Promise.resolve().then(() => {
          rec.notice = "n1";
          calls.push(`notice ${rec.id}`);
        }),
      }),
    });
    r.submit({ id: "a", session: "s", text: "one" }, true);
    r.submit({ id: "b", session: "s", text: "two" }, true); // queued behind a → gets the notice
    await r.idle();
    expect(calls).toEqual([
      "add a",
      "seen a",
      "add b",
      "seen b",
      "notice b", // fired on acceptance, settled BEFORE b's attempt is counted — b holds its preview handle
      "attempt a",
      "peek place:s",
      "execute a notice=- text=earlier",
      "remove a",
      "commit place:s e1",
      "remove a",
      "attempt b",
      "peek place:s",
      "execute b notice=n1 text=earlier",
      "remove b",
      "commit place:s e1",
      "remove b",
    ]);
  });

  it("a turn at the ceiling is dropped and told; a deferred one is left for the next start", async () => {
    const { store, calls } = fakeStore({ x: "exceeded", d: "defer" });
    const r = runner(store, calls);
    r.submit({ id: "x", session: "s1", text: "" }, false);
    r.submit({ id: "d", session: "s2", text: "" }, false);
    await r.idle();
    expect(calls.filter((c) => !c.startsWith("attempt"))).toEqual(["dropped x", "deferred d"]);
  });

  it("beforeRun false leaves the intent untouched — nothing counted, nothing run, nothing removed", async () => {
    const { store, calls } = fakeStore();
    const r = runner(store, calls, { beforeRun: async () => false });
    r.submit({ id: "a", session: "s", text: "" }, false);
    await r.idle();
    expect(calls).toEqual([]);
  });

  it("a failed execute still drops the intent, and a recovered turn is re-enqueued without re-persisting", async () => {
    const { store, calls, recovered } = fakeStore();
    recovered.push({ id: "r", session: "s", text: "again", attempts: 1 });
    const r = runner(store, calls, {
      execute: async (rec) => {
        calls.push(`execute ${rec.id}`);
        throw new Error("transport down");
      },
    });
    expect(r.recover()).toHaveLength(1);
    await r.idle();
    expect(calls).toEqual(["attempt r", "peek place:s", "execute r", "remove r"]);
  });
});
