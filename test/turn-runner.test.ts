import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ContextBuffer, createContextBuffer } from "../src/channels/kit/context-buffer.ts";
import { createTurnRunner, runQueuedTurn, type TurnRunnerOptions } from "../src/channels/kit/turn-runner.ts";
import { type TurnRecordBase, type TurnStore, createTurnStore } from "../src/channels/kit/turn-store.ts";
import { createTurnQueue } from "../src/channels/kit/turn-queue.ts";
import { portJoin } from "../src/effect-port.ts";
import { activeWork } from "../src/channels/busy.ts";
import * as atomic from "../src/atomic-write.ts";
import { log } from "../src/log.ts";

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
    peek: (key: string) => {
      calls.push(`peek ${key}`);
      return { text: "earlier", consumed: ["e1"] };
    },
    commit: (key: string, consumed: string[]) => {
      calls.push(`commit ${key} ${consumed.join(",")}`);
    },
  };
}

function runnerOptions(
  store: TurnStore<Stored>,
  calls: string[],
  overrides: Partial<TurnRunnerOptions<Pending, Stored, string>> = {},
): TurnRunnerOptions<Pending, Stored, string> {
  return {
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
    execute: (rec, discussion, onCompleted) =>
      portJoin(async () => {
        calls.push(`execute ${rec.id} notice=${rec.notice ?? "-"} text=${discussion.text}`);
        onCompleted();
      }),
    ...overrides,
  };
}
const runner = (
  store: TurnStore<Stored>,
  calls: string[],
  overrides: Partial<TurnRunnerOptions<Pending, Stored, string>> = {},
) => createTurnRunner(runnerOptions(store, calls, overrides));

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function durable() {
  const dir = mkdtempSync(join(tmpdir(), "turn-runner-"));
  dirs.push(dir);
  const storePath = join(dir, "turns.json");
  const openStore = () =>
    createTurnStore<Stored>(storePath, {
      label: "[t]",
      isRecord: (r): r is Stored => typeof r === "object" && r !== null && "attempts" in r,
      order: (a, b) => a.id.localeCompare(b.id),
    });
  const openBuffer = () =>
    createContextBuffer<string>({
      path: join(dir, "buffer.json"),
      label: "[t]",
      isEntry: (entry): entry is string => typeof entry === "string",
      line: (entry) => entry,
    });
  return { dir, storePath, openStore, openBuffer, store: openStore(), buffer: openBuffer() };
}

describe("turn runner: the lifecycle order every chat channel shares", () => {
  it("SIGTERM preserves the durable state, running or committed", async () => {
    for (const phase of ["running", "committed"]) {
      const { dir, openStore, openBuffer } = durable();
      const source = new URL("../src/channels/kit/", import.meta.url).href;
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { createTurnRunner } from ${JSON.stringify(`${source}turn-runner.ts`)};
        import { portJoin } from ${JSON.stringify(new URL("../src/effect-port.ts", import.meta.url).href)};
        import { createTurnStore } from ${JSON.stringify(`${source}turn-store.ts`)};
        import { createContextBuffer } from ${JSON.stringify(`${source}context-buffer.ts`)};
        const root = ${JSON.stringify(dir)};
        const store = createTurnStore(root + '/turns.json', { label: '[child]', isRecord: () => true, order: () => 0 });
        const buffer = createContextBuffer({ path: root + '/buffer.json', label: '[child]', isEntry: () => true, line: x => x });
        buffer.push('place:s', 'earlier');
        const runner = createTurnRunner({
          label: '[child]', store, buffer, toStored: r => ({ ...r, attempts: 0 }), fromStored: r => r,
          bufferKey: () => 'place:s', where: () => 'child', onDeferred: () => {}, notifyDropped: () => {},
          execute: (_rec, _discussion, onCompleted) => portJoin(async () => {
            process.on('message', () => {
              onCompleted();
              buffer.push('place:s', 'later');
              process.send('committed');
            });
            process.send('running');
            await new Promise(() => {});
          }),
        });
        runner.submit({ id: 'a', session: 's', text: '' }, true);
      `,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr?.on("data", (data) => {
        stderr += data;
      });
      const exited = once(child, "exit");
      const message = () =>
        Promise.race([
          once(child, "message").then(([value]) => value),
          exited.then(() => {
            throw new Error(`child exited before the expected message: ${stderr}`);
          }),
        ]);
      try {
        expect(await message()).toBe("running");
        if (phase === "committed") {
          const committed = message();
          child.send("complete");
          expect(await committed).toBe("committed");
        }
      } finally {
        child.kill("SIGTERM");
        await exited;
      }
      expect(openStore().recover()).toEqual(
        phase === "running" ? [{ id: "a", session: "s", text: "", attempts: 1 }] : [],
      );
      expect(openBuffer().peek("place:s").consumed).toEqual(phase === "running" ? ["earlier"] : ["later"]);
    }
  });

  it("observes a rejected queue notice while its predecessor is still running", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const head = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const { store, calls } = fakeStore();
    const r = runner(store, calls, {
      onQueuedBehind: () => ({ done: Promise.reject(new Error("notice rejected before dequeue")) }),
      execute: (rec) =>
        portJoin(async () => {
          if (rec.id === "a") {
            entered.resolve();
            await head.promise;
          }
        }),
    });
    r.submit({ id: "a", session: "s", text: "" }, true);
    r.submit({ id: "b", session: "s", text: "" }, true);
    try {
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(warn.mock.calls.flat().join(" ")).toContain("notice rejected before dequeue");
      expect(calls).not.toContain("attempt b");
    } finally {
      head.resolve();
      await r.idle();
    }
    expect(calls).toContain("attempt b");
  });

  it("joins the notice even when its cancel hook throws, leaving the turn for recovery", async () => {
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    const posted = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const base = activeWork();
    const { store, calls } = fakeStore();
    const r = runner(store, calls, {
      onQueuedBehind: () => ({
        done: posted.promise,
        cancel: () => {
          cancelled.resolve();
          throw new Error("cancel broke");
        },
      }),
    });
    r.submit({ id: "a", session: "s", text: "" }, true);
    r.submit({ id: "b", session: "s", text: "" }, true);
    try {
      await cancelled.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(activeWork()).toBe(base + 1);
      expect(calls).not.toContain("attempt b");
    } finally {
      posted.resolve();
      await r.idle();
    }
    expect(calls).not.toContain("remove b");
    expect(errors.mock.calls.flat().join(" ")).toContain("cancel broke");
    expect(activeWork()).toBe(base);
  });

  it("interruption joins work and preserves the actual commit decision, committed or not", async () => {
    for (const completed of [false, true]) {
      const { store, buffer, openStore, openBuffer } = durable();
      buffer.push("place:s", "earlier");
      store.add({ id: "a", session: "s", text: "", attempts: 0 });
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let running!: Fiber.Fiber<unknown, unknown>;
      const opts = runnerOptions(store, [], {
        buffer,
        execute: (_rec, discussion, onCompleted) =>
          portJoin(async () => {
            expect(discussion.consumed).toEqual(["earlier"]);
            if (completed) onCompleted();
            entered.resolve();
            await finish.promise;
          }),
      });
      const base = activeWork();
      const queue = createTurnQueue<Pending>({
        label: "[t]",
        run: (rec) =>
          Effect.gen(function* () {
            running = yield* Effect.withFiber(Effect.succeed);
            yield* runQueuedTurn(opts, rec);
          }),
      });
      queue.accept({ id: "a", session: "s", text: "" });
      await entered.promise;
      buffer.push("place:s", "later");
      const interrupted = Effect.runPromise(Fiber.interrupt(running));
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(activeWork()).toBe(base + 1);
      } finally {
        finish.resolve();
        await interrupted;
        await queue.idle();
      }
      expect(activeWork()).toBe(base);
      expect(openStore().recover()).toEqual(completed ? [] : [{ id: "a", session: "s", text: "", attempts: 1 }]);
      expect(openBuffer().peek("place:s").consumed).toEqual(completed ? ["later"] : ["earlier", "later"]);
      if (!completed) {
        const replay = runner(openStore(), [], { buffer: openBuffer() });
        expect(replay.recover()).toHaveLength(1);
        await replay.idle();
        expect(openStore().recover()).toEqual([]);
        expect(openBuffer().peek("place:s").consumed).toEqual([]);
      }
    }
  });

  it("pre-ACK persistence and attempt failures preserve dedup, busy accounting and restart recovery", async () => {
    const { store, buffer, storePath, openStore } = durable();
    const calls: string[] = [];
    const base = activeWork();
    const r = runner(store, calls, { buffer });
    const write = vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => {
      throw new Error("disk failed");
    });
    const rec = { id: "a", session: "s", text: "" };
    expect(() => r.submit(rec, true)).toThrow("disk failed");
    expect(calls).toEqual([]);
    expect(activeWork()).toBe(base);
    write.mockRestore();
    r.submit(rec, true);
    expect(openStore().recover()).toMatchObject([{ id: "a", attempts: 0 }]);
    const original = atomic.writeFileAtomic;
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, ...args) => {
      if (path === storePath) throw new Error("attempt write failed");
      return original(path, ...args);
    });
    await r.idle();
    expect(calls).toEqual(["seen a", "deferred a"]);
    expect(openStore().recover()).toMatchObject([{ id: "a", attempts: 0 }]);
    expect(activeWork()).toBe(base);
  });

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

  it("a rejected queue notice does not abort the turn, so the intent is still counted, run and dropped", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const { store, calls } = fakeStore();
      const r = runner(store, calls, { onQueuedBehind: () => ({ done: Promise.reject(new Error("post failed")) }) });
      r.submit({ id: "a", session: "s", text: "one" }, false);
      r.submit({ id: "b", session: "s", text: "two" }, false); // queued behind a → gets the failing notice
      await r.idle();
      expect(calls.filter((c) => c.endsWith(" b") || c.startsWith("execute b"))).toEqual([
        "attempt b",
        "execute b notice=- text=earlier",
        "remove b",
        "remove b",
      ]);
      // Swallowing it is the point, so the swallow owes a signal: without this the catch could go
      // silent and every assertion above would still pass.
      expect(warn.mock.calls.flat().join(" ")).toContain("turn=b");
    } finally {
      warn.mockRestore();
    }
  });

  it("a failed execute still drops the intent, and a recovered turn is re-enqueued without re-persisting", async () => {
    const { store, calls, recovered } = fakeStore();
    recovered.push({ id: "r", session: "s", text: "again", attempts: 1 });
    const r = runner(store, calls, {
      execute: (rec) =>
        portJoin(async () => {
          calls.push(`execute ${rec.id}`);
          throw new Error("transport down");
        }),
    });
    expect(r.recover()).toHaveLength(1);
    await r.idle();
    expect(calls).toEqual(["attempt r", "peek place:s", "execute r", "remove r"]);
  });
});
