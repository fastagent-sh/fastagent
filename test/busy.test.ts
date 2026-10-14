import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPiAgentFromDir } from "../src/harnesses/pi/open.ts";
import { collect } from "../src/protocol-collect.ts";
import { activeWork, beginWork } from "../src/channels/busy.ts";
import { portJoin } from "../src/effect-port.ts";
import { createTaskTracker } from "../src/channels/kit/tasks.ts";
import { createTurnQueue } from "../src/channels/kit/turn-queue.ts";
import * as Effect from "effect/Effect";
import type { Lease } from "../src/harnesses/pi/turn-kit.ts";
import { acquireSessionLease } from "../src/harnesses/pi/session-effects.ts";

/** Wait until `cond` holds (settlement callbacks run on the microtask queue). */
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("channels/busy: the process-wide in-flight signal", () => {
  it("a session leased for a turn or a write counts, on any Lease, until the lease is released", async () => {
    // A Lease of an embedder's own (a distributed lock) is acquired at the same one point, so it counts too.
    const own: Lease = { tryAcquire: () => () => {} };
    const base = activeWork();
    let during = -1;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireSessionLease(own, "s");
          during = activeWork();
        }),
      ),
    );
    expect(during).toBe(base + 1);
    expect(activeWork()).toBe(base);
    // A refused lease is no work.
    await Effect.runPromise(Effect.exit(Effect.scoped(acquireSessionLease({ tryAcquire: () => null }, "s"))));
    expect(activeWork()).toBe(base);
  });

  it("counts begin → done, and done is idempotent", () => {
    const base = activeWork();
    const done = beginWork();
    expect(activeWork()).toBe(base + 1);
    done();
    expect(activeWork()).toBe(base);
    done(); // settled twice (finally + catch cleanup paths) — must not go negative
    expect(activeWork()).toBe(base);
  });

  it("a turn accepted onto the queue reads busy from acceptance until its run settles", async () => {
    const base = activeWork();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const queue = createTurnQueue<{ session: string }>({ label: "[test]", run: () => portJoin(() => gate) });
    queue.accept({ session: "s" });
    expect(activeWork()).toBe(base + 1); // queued/running both count — the process must not idle
    release();
    await queue.idle();
    await until(() => activeWork() === base);
    expect(activeWork()).toBe(base);
  });

  it("a QUEUED turn behind an active one also counts (two accepted = two units)", async () => {
    const base = activeWork();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const queue = createTurnQueue<{ session: string }>({ label: "[test]", run: () => portJoin(() => gate) });
    queue.accept({ session: "s" });
    queue.accept({ session: "s" });
    expect(activeWork()).toBe(base + 2);
    release();
    await queue.idle();
    await until(() => activeWork() === base);
    expect(activeWork()).toBe(base);
  });

  it("a tracked side task counts until it settles — rejection included", async () => {
    const base = activeWork();
    const tracker = createTaskTracker("[test]");
    let reject: (e: Error) => void = () => {};
    const task = new Promise<void>((_r, rj) => {
      reject = rj;
    });
    tracker.track(task.catch(() => {})); // the caller owns the error (tasks.ts contract)
    expect(activeWork()).toBe(base + 1);
    reject(new Error("boom"));
    await tracker.drain();
    await until(() => activeWork() === base);
    expect(activeWork()).toBe(base);
  });
});

describe("an opened agent's runs", () => {
  it("count as work in flight from the moment a run starts until it ends", async () => {
    // Without it, /ping says Healthy and `dev` restarts mid-run: the host reclaims a container that is still working.
    const held: ServerResponse[] = [];
    const server = createServer((_req, res) => {
      held.push(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const dir = await mkdtemp(join(tmpdir(), "fa-open-busy-"));
      await writeFile(join(dir, "fastagent.config.ts"), `export default { model: "held/held" };\n`);
      await writeFile(
        join(dir, "models.json"),
        JSON.stringify({
          providers: {
            held: {
              baseUrl: `http://127.0.0.1:${port}/v1`,
              api: "openai-completions",
              apiKey: "test",
              models: [{ id: "held" }],
            },
          },
        }),
      );
      const { agent } = await createPiAgentFromDir(dir);
      const base = activeWork();
      const run = collect(agent.invoke({ sessionId: "s", prompt: { text: "hi" } })).catch((e: unknown) => e);
      await until(() => held.length > 0);
      expect(activeWork()).toBeGreaterThan(base);
      for (const res of held) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "refused", type: "bad_request" } }));
      }
      await run;
      await until(() => activeWork() === base);
      expect(activeWork()).toBe(base);
    } finally {
      for (const res of held) res.destroy();
      server.close();
    }
  });
});
