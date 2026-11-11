import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Discussion } from "../src/channels/kit/place-history.ts";
import { createTurnRunner, runQueuedTurn, type TurnRunnerOptions } from "../src/channels/kit/turn-runner.ts";
import type { SeenRing } from "../src/channels/kit/seen.ts";
import { type TurnRecordBase, type TurnStore, createTurnStore } from "../src/channels/kit/turn-store.ts";
import { createTurnQueue } from "../src/channels/turn-queue.ts";
import { PortFailure, portJoin } from "../src/effect-port.ts";
import type { TurnEvent } from "../src/channels/kit/invoke-turn-kit.ts";
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
    answered: (id, answer) => {
      calls.push(`answered ${id} ${answer}`);
      return true;
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

/** What a turn folds: a read the test can see, answering "earlier". */
function fakeDiscussion(calls: string[]) {
  return async (rec: Pending): Promise<Discussion<string>> => {
    calls.push(`read ${rec.conversation}`);
    return { text: "earlier", folded: ["e1"] };
  };
}

/** The answers delivered so far, in memory. */
function deliveredRing(): SeenRing {
  const ids = new Set<string>();
  return { has: (id) => ids.has(id), add: (id) => void ids.add(id) };
}

function runnerOptions(
  store: TurnStore<Stored>,
  calls: string[],
  overrides: Partial<TurnRunnerOptions<Pending, Stored, string>> = {},
): TurnRunnerOptions<Pending, Stored, string> {
  return {
    label: "[t]",
    store,
    discussion: fakeDiscussion(calls),
    seen: { add: (id) => calls.push(`seen ${id}`) },
    toStored: ({ notice: _n, ...intent }) => ({ ...intent, attempts: 0 }),
    fromStored: ({ attempts: _a, ...intent }) => ({ ...intent, notice: undefined }),
    where: (rec) => `conversation=${rec.conversation}`,
    delivered: deliveredRing(),
    notifyDropped: (rec) => calls.push(`dropped ${rec.id}`),
    deliverAnswer: (rec, answer) =>
      portJoin(async () => {
        calls.push(`deliver ${rec.id} answer=${answer}`);
      }),
    execute: (rec, discussion, onAnswered) =>
      portJoin(async () => {
        calls.push(`execute ${rec.id} notice=${rec.notice ?? "-"} text=${discussion.text}`);
        onAnswered("the answer");
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
  return { dir, storePath, openStore, store: openStore() };
}

describe("turn runner: the lifecycle order every chat channel shares", () => {
  it("SIGTERM preserves the durable state, running or answered", async () => {
    for (const phase of ["running", "committed"]) {
      const { dir, openStore } = durable();
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
        const root = ${JSON.stringify(dir)};
        const store = createTurnStore(root + '/turns.json', { label: '[child]', isRecord: () => true, order: () => 0 });
        const runner = createTurnRunner({
          label: '[child]', store, discussion: async () => ({ text: '', folded: [] }), toStored: r => ({ ...r, attempts: 0 }), fromStored: r => r,
          discussionKey: () => 'place:s', where: () => 'child', onDeferred: () => {}, notifyDropped: () => {},
          deliverAnswer: () => portJoin(async () => {}),
          execute: (_rec, _discussion, onAnswered) => portJoin(async () => {
            process.on('message', () => {
              onAnswered('the answer');
              process.send('answered');
            });
            process.send('running');
            await new Promise(() => {});
          }),
        });
        runner.submit({ id: 'a', conversation: 's', text: '' }, true);
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
        expect(await message(), phase).toBe("running");
        if (phase === "committed") {
          const answered = message();
          child.send("complete");
          expect(await answered, phase).toBe("answered");
        }
      } finally {
        child.kill("SIGTERM");
        await exited;
      }
      // Killed mid-delivery, the answer is on disk to re-deliver; killed mid-run, only the intent is.
      expect(openStore().recover(), phase).toEqual([
        {
          id: "a",
          conversation: "s",
          text: "",
          attempts: 1,
          ...(phase === "committed" ? { answer: "the answer" } : {}),
        },
      ]);
    }
  });

  it("interruption joins work and keeps the record, answered or not", async () => {
    for (const completed of [false, true]) {
      const { store, openStore } = durable();
      store.add({ id: "a", conversation: "s", text: "", attempts: 0 });
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let running!: Fiber.Fiber<unknown, unknown>;
      const opts = runnerOptions(store, [], {
        execute: (_rec, discussion, onAnswered) =>
          portJoin(async () => {
            expect(discussion.folded).toEqual(["e1"]);
            if (completed) onAnswered("the answer");
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
      queue.accept({ id: "a", conversation: "s", text: "" });
      await entered.promise;
      const label = `completed=${completed}`;
      const interrupted = Effect.runPromise(Fiber.interrupt(running));
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(activeWork(), label).toBe(base + 1);
      } finally {
        finish.resolve();
        await interrupted;
        await queue.idle();
      }
      expect(activeWork(), label).toBe(base);
      // Either way the record survives interruption — but it means different work on the next start: an answer to
      // deliver, or a turn to run.
      expect(openStore().recover(), label).toEqual([
        { id: "a", conversation: "s", text: "", attempts: 1, ...(completed ? { answer: "the answer" } : {}) },
      ]);
      const calls: string[] = [];
      const replay = runner(openStore(), calls);
      expect(replay.recover(), label).toHaveLength(1);
      await replay.idle();
      expect(
        calls.filter((c) => c.startsWith("deliver") || c.startsWith("execute")).map((c) => c.split("\n")[0]),
        label,
      ).toEqual(completed ? ["deliver a answer=the answer"] : ["execute a notice=- text=earlier"]);
      expect(openStore().recover(), label).toEqual([]);
      // A re-delivery reads no discussion: the answer exists, and only its delivery is owed.
      expect(
        calls.filter((c) => c.startsWith("read")),
        label,
      ).toEqual(completed ? [] : ["read s"]);
    }
  });

  it("pre-ACK persistence and attempt failures preserve dedup, busy accounting and restart recovery", async () => {
    const { store, storePath, openStore } = durable();
    const calls: string[] = [];
    const base = activeWork();
    const r = runner(store, calls);
    const write = vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => {
      throw new Error("disk failed");
    });
    const rec = { id: "a", conversation: "s", text: "" };
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
    expect(calls).toEqual(["seen a"]);
    expect(openStore().recover()).toMatchObject([{ id: "a", attempts: 0 }]);
    expect(activeWork()).toBe(base);
  });

  it("accepts, counts the attempt, folds, executes, records the answer, delivers, drops", async () => {
    const { store, calls } = fakeStore();
    const r = runner(store, calls);
    r.submit({ id: "a", conversation: "s", text: "one" }, true);
    r.submit({ id: "b", conversation: "s", text: "two" }, true);
    await r.idle();
    expect(calls).toEqual([
      "add a",
      "seen a",
      "add b",
      "seen b",
      "attempt a",
      "read s",
      "execute a notice=- text=earlier",
      "answered a the answer", // the answer is durable BEFORE delivery; the intent outlives it
      "remove a", // only now — delivery settled
      "attempt b",
      "read s",
      "execute b notice=- text=earlier",
      "answered b the answer",
      "remove b",
    ]);
  });

  it("starts the next input of a conversation once the earlier turn admits its message, not when it ends", async () => {
    const { store, calls } = fakeStore();
    const gate = Promise.withResolvers<void>();
    const r = runner(store, calls, {
      execute: (rec, _discussion, _onAnswered, turn) =>
        portJoin(async () => {
          calls.push(`execute ${rec.id}`);
          turn.admitted();
          if (rec.id === "a") await gate.promise;
          calls.push(`ended ${rec.id}`);
        }),
    });
    r.submit({ id: "a", conversation: "s", text: "one" }, false);
    r.submit({ id: "b", conversation: "s", text: "two" }, false);
    await vi.waitFor(() => expect(calls).toContain("execute b"));
    expect(calls).not.toContain("ended a"); // b was sent while a is still waiting for its answer
    gate.resolve();
    await r.idle();
  });

  it("holds an input back while an earlier turn runs, even when the turn just before it failed at once", async () => {
    const { store, calls } = fakeStore();
    const gate = Promise.withResolvers<void>();
    const answered = (): Stream.Stream<TurnEvent, PortFailure> =>
      Stream.fromIterable<TurnEvent>([
        { type: "message", message: { id: "m3", sessionId: "s", status: "queued" } },
        {
          type: "done",
          message: { id: "m3", sessionId: "s", status: "completed", answer: { entryId: "e1", text: "x" } },
        },
      ]);
    const running = Stream.concat(
      Stream.fromIterable<TurnEvent>([{ type: "message", message: { id: "m1", sessionId: "s", status: "running" } }]),
      Stream.fromEffect(
        Effect.promise(() => gate.promise).pipe(
          Effect.as<TurnEvent>({
            type: "done",
            message: { id: "m1", sessionId: "s", status: "completed", answer: { entryId: "e1", text: "x" } },
          }),
        ),
      ),
    );
    const r = runner(store, calls, {
      execute: (rec, _discussion, _onAnswered, turn) => {
        if (rec.id === "b") return Effect.fail(new PortFailure(new Error("its message was refused"))); // ends at once
        turn.admitted();
        const events = (rec.id === "a" ? running : answered()).pipe(
          // What the turn's stream tells the runner, as `turnStream` does: the message's end.
          Stream.tap((event) => Effect.sync(() => (event.type === "done" ? turn.observe(event.message) : undefined))),
        );
        return turn.reply(events, (stream) =>
          Stream.runDrain(stream).pipe(Effect.tap(() => Effect.sync(() => void calls.push(`rendered ${rec.id}`)))),
        );
      },
    });
    vi.spyOn(log, "error").mockImplementation(() => {});
    r.submit({ id: "a", conversation: "s", text: "" }, false);
    r.submit({ id: "b", conversation: "s", text: "" }, false);
    await vi.waitFor(() => expect(calls).toContain("remove b")); // b ended; a is still running
    r.submit({ id: "c", conversation: "s", text: "" }, false);
    await vi.waitFor(() => expect(calls).toContain("attempt c"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // c's input was steered into a's run and shares its answer, so it renders nothing until a has delivered it.
    expect(calls).not.toContain("rendered c");
    gate.resolve();
    await r.idle();
    expect(calls).toContain("rendered a");
    expect(calls).not.toContain("rendered c"); // a delivered the shared answer, so c's turn is skipped
  });

  it("a recovered answer another turn already delivered is dropped, not sent twice", async () => {
    const { store, calls, recovered } = fakeStore();
    recovered.push({ id: "r", conversation: "s", text: "", attempts: 1, answer: "shared", answerKey: "s1:e9" });
    const ring = deliveredRing();
    ring.add("s1:e9");
    const r = runner(store, calls, { delivered: ring });
    r.recover();
    await r.idle();
    expect(calls.filter((c) => c.startsWith("deliver"))).toEqual([]);
    expect(calls).toContain("remove r");
  });

  it("a recovered answer is delivered once and remembered by its key", async () => {
    const { store, calls, recovered } = fakeStore();
    recovered.push({ id: "r1", conversation: "s", text: "", attempts: 1, answer: "shared", answerKey: "s1:e9" });
    recovered.push({ id: "r2", conversation: "s", text: "", attempts: 1, answer: "shared", answerKey: "s1:e9" });
    const ring = deliveredRing();
    const r = runner(store, calls, { delivered: ring });
    r.recover();
    await r.idle();
    expect(calls.filter((c) => c.startsWith("deliver"))).toEqual(["deliver r1 answer=shared"]);
    expect(ring.has("s1:e9")).toBe(true);
    expect(calls.filter((c) => c.startsWith("remove")).sort()).toEqual(["remove r1", "remove r2"]);
  });

  it("a turn at the ceiling is dropped and told; a deferred one is left for the next start", async () => {
    const { store, calls } = fakeStore({ x: "exceeded", d: "defer" });
    const r = runner(store, calls);
    r.submit({ id: "x", conversation: "s1", text: "" }, false);
    r.submit({ id: "d", conversation: "s2", text: "" }, false);
    await r.idle();
    expect(calls.filter((c) => !c.startsWith("attempt"))).toEqual(["dropped x"]);
  });

  it("a turn at the ceiling that already has its answer is delivered, not dropped with an apology", async () => {
    // The ceiling stops EXECUTION — the risk it guards against is a turn that keeps killing the process. Sending a
    // recorded answer runs no model, so an answer that exists must not be replaced by "please ask again".
    const { store, calls } = fakeStore({ x: "exceeded" });
    const r = runner(store, calls);
    r.submit({ id: "x", conversation: "s1", text: "", answer: "the answer nobody received" }, false);
    await r.idle();
    expect(calls.filter((c) => !c.startsWith("attempt"))).toEqual(["deliver x answer=the answer nobody received"]);
  });

  it("a ceiling delivery that fails still ends the ask — nothing retries it and a queue notice would stay", async () => {
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    const { store, calls } = fakeStore({ x: "exceeded" });
    const r = runner(store, calls, {
      deliverAnswer: (rec) =>
        portJoin(async () => {
          calls.push(`deliver ${rec.id}`);
          throw new Error("chat not found");
        }),
    });
    r.submit({ id: "x", conversation: "s1", text: "", answer: "the answer nobody received" }, false);
    await r.idle();
    // The record is already off disk, so this is the last chance to say anything to the asker.
    expect(calls.filter((c) => !c.startsWith("attempt"))).toEqual(["deliver x", "dropped x"]);
    expect(errors.mock.calls.flat().join(" ")).toContain("the answer is gone");
  });

  it("beforeRun false leaves the intent untouched — nothing counted, nothing run, nothing removed", async () => {
    const { store, calls } = fakeStore();
    const r = runner(store, calls, { beforeRun: async () => false });
    r.submit({ id: "a", conversation: "s", text: "" }, false);
    await r.idle();
    expect(calls).toEqual([]);
  });

  it("a failed execute still drops the intent, and a recovered turn is re-enqueued without re-persisting", async () => {
    const { store, calls, recovered } = fakeStore();
    recovered.push({ id: "r", conversation: "s", text: "again", attempts: 1 });
    const r = runner(store, calls, {
      execute: (rec) =>
        portJoin(async () => {
          calls.push(`execute ${rec.id}`);
          throw new Error("transport down");
        }),
    });
    expect(r.recover()).toHaveLength(1);
    await r.idle();
    expect(calls).toEqual(["attempt r", "read s", "execute r", "remove r"]);
  });
});
