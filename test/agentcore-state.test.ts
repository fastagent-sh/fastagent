/**
 * The cross-deploy state snapshot. AgentCore erases the /mnt/state mount on every runtime version
 * update (= every deploy), so these paths ARE the agent's memory: a regression here loses sessions,
 * channel dedup and pending wake-ups silently. Each test states the loss it prevents.
 */
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { activeWork, onIdle } from "../src/channels/busy.ts";
import { log } from "../src/log.ts";
import { createScheduler } from "../src/schedule/scheduler.ts";
import { createWakeAlarmSink } from "../src/schedule/wake-alarm.ts";
import { setWakeupsSink } from "../src/schedule/wakeups.ts";
import {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_VERSION,
  createStateSync as stateSync,
  packStateRoot,
  unpackIntoStateRoot,
} from "../src/channels/agentcore-state.ts";

const createStateSync = (options: Parameters<typeof stateSync>[0]) => Effect.runSync(stateSync(options));

const dirs: string[] = [];
async function stateRoot(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fastagent-state-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A fetch double: records calls, replies from a script. */
function fakeFetch(script: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; body?: Uint8Array }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body instanceof Uint8Array ? init.body : undefined,
    });
    return script(String(url), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const urls = { getUrl: "https://s3/get", putUrl: "https://s3/put" };

describe("agentcore state snapshot", () => {
  it("round-trips the whole state root, nested paths included", async () => {
    const source = await stateRoot({
      ".secrets/auth.json": '{"token":"t"}',
      "sessions/8335403535.jsonl": '{"role":"user"}\n{"role":"assistant"}\n',
      "schedule/wakeups.json": '{"pending":[{"id":"a"}]}',
    });
    const target = await stateRoot();
    const written = await unpackIntoStateRoot(target, await packStateRoot(source));

    expect(written).toBe(3);
    expect(await readFile(join(target, "sessions/8335403535.jsonl"), "utf8")).toBe(
      '{"role":"user"}\n{"role":"assistant"}\n',
    );
    expect(await readFile(join(target, "schedule/wakeups.json"), "utf8")).toBe('{"pending":[{"id":"a"}]}');
  });

  it("the snapshot's auth.json WINS over the deploy seed — the box's copy is the refreshed one", async () => {
    // Same rule as every other host's volume: "a credential already refreshed is never overwritten".
    // The seed is bootstrap for a snapshot that has none, not an authority over one that does.
    //
    // At the REAL path: the generated template sets FASTAGENT_SECRETS_DIR to `<state root>/.secrets`
    // (deploy/agentcore/plan.ts SECRETS_DIR), which is the whole reason this file is reachable here.
    // Asserting it at the state root instead would keep passing even if the secrets dir were moved
    // outside the snapshot — the exact regression that costs the deployment its model access.
    const source = await stateRoot({ ".secrets/auth.json": "REFRESHED-ON-THE-BOX", "sessions/s.jsonl": "keep" });
    const target = await stateRoot({ ".secrets/auth.json": "SEEDED-BY-THIS-DEPLOY" });

    await unpackIntoStateRoot(target, await packStateRoot(source));

    expect(await readFile(join(target, ".secrets/auth.json"), "utf8")).toBe("REFRESHED-ON-THE-BOX");
    expect(await readFile(join(target, "sessions/s.jsonl"), "utf8")).toBe("keep");
  });

  it("a rotated credential survives the FULL microVM cycle — seed, rotate, snapshot, wipe, restore", async () => {
    // The failure this locks out is a slow one: an OAuth refresh token is single-use, so a box that
    // loses its rotated copy re-seeds a token the provider already invalidated and eventually cannot
    // authenticate at all — with a redeploy as the only cure.
    const box1 = await stateRoot({ ".secrets/auth.json": "R0-SEEDED" });
    await writeFile(join(box1, ".secrets/auth.json"), "R1-ROTATED"); // a turn refreshes the token
    const snapshot = await packStateRoot(box1); // …and the settle pushes it to S3

    const box2 = await stateRoot({ ".secrets/auth.json": "R0-SEEDED" }); // the mount was wiped; boot re-seeds
    await unpackIntoStateRoot(box2, snapshot); // the first envelope restores before any model call

    expect(await readFile(join(box2, ".secrets/auth.json"), "utf8")).toBe("R1-ROTATED");
  });

  it("never carries control.json — it is this boot's URL+token, worthless (and misleading) to the next", async () => {
    const source = await stateRoot({ "control.json": '{"url":"http://127.0.0.1:8787","token":"old"}' });
    const target = await stateRoot({ "control.json": '{"url":"http://127.0.0.1:9000","token":"current"}' });

    const packed = await packStateRoot(source);
    expect(JSON.parse(gunzipSync(packed).toString()).files["control.json"]).toBeUndefined();

    await unpackIntoStateRoot(target, packed);
    expect(await readFile(join(target, "control.json"), "utf8")).toContain("current"); // untouched
  });

  it("packing an empty/absent state root is valid (first boot), and restores as zero files", async () => {
    const packed = await packStateRoot(join(await stateRoot(), "nonexistent"));
    expect(await unpackIntoStateRoot(await stateRoot(), packed)).toBe(0);
  });

  it("refuses a snapshot that would escape the state root, or one from an unknown version", async () => {
    const target = await stateRoot();
    const escaping = gzipSync(
      Buffer.from(
        JSON.stringify({ v: SNAPSHOT_VERSION, files: { "../escaped": Buffer.from("x").toString("base64") } }),
      ),
    );
    await expect(unpackIntoStateRoot(target, escaping)).rejects.toThrow(/unsafe path/);

    const future = gzipSync(Buffer.from(JSON.stringify({ v: 99, files: {} })));
    await expect(unpackIntoStateRoot(target, future)).rejects.toThrow(/unsupported shape/);

    await expect(unpackIntoStateRoot(target, Buffer.from("not gzip"))).rejects.toThrow(/unreadable/);
  });

  it.each([[], { "a.json": [1, 2] }])(
    "rejects malformed snapshot files before treating the root as authoritative: %j",
    async (files) => {
      const packed = gzipSync(Buffer.from(JSON.stringify({ v: SNAPSHOT_VERSION, files })));
      const { impl, calls } = fakeFetch(() => new Response(packed));
      const sync = createStateSync({ stateRoot: await stateRoot(), fetchImpl: impl });
      sync.use(urls);
      await expect(sync.ready()).rejects.toThrow(/unsupported shape|invalid file content/);
      sync.save();
      await sync.flush();
      expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    },
  );

  it("caps the packed size — a runaway state root fails visibly instead of OOMing the microVM", async () => {
    const dir = await stateRoot();
    await writeFile(join(dir, "big.bin"), Buffer.alloc(4096));

    // Drive the real guard through an injected cap (writing 64 MiB to prove a branch is not a test).
    await expect(packStateRoot(dir, 1024)).rejects.toThrow(/exceeds 1024 bytes/);
    await expect(packStateRoot(dir, MAX_SNAPSHOT_BYTES)).resolves.toBeInstanceOf(Buffer);
  });

  describe("sync lifecycle", () => {
    it.each([false, true])(
      "snapshots the settled wake after a synchronous alarm pass (future wake=%s)",
      async (future) => {
        const now = new Date("2026-07-28T10:00:00Z");
        const pending = [{ id: "due", session: "s", prompt: "go", fireAt: now.toISOString() }];
        if (future) pending.push({ id: "future", session: "s", prompt: "later", fireAt: "2026-07-28T11:00:00Z" });
        const before = '{"role":"user","content":"go"}\n';
        const after = `${before}{"role":"assistant","content":"done"}\n`;
        const local = await stateRoot({ "sessions/s.jsonl": before, "schedule/wakeups.json": JSON.stringify(pending) });
        const entered = Promise.withResolvers<void>();
        const finishTurn = Promise.withResolvers<void>();
        const putStarted = Promise.withResolvers<void>();
        const finishPut = Promise.withResolvers<void>();
        const { impl, calls } = fakeFetch(async (_url, init) => {
          if (init?.method === "PUT") {
            putStarted.resolve();
            await finishPut.promise;
            return new Response(null);
          }
          return new Response(null, { status: 404 });
        });
        const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
        sync.use(urls);
        await sync.ready();
        const alarmFetch = vi.fn<typeof fetch>();
        setWakeupsSink(Effect.runSync(createWakeAlarmSink({ secret: "s", fetchImpl: alarmFetch, now: () => now })));
        const idle = vi.fn(() => sync.save());
        const off = onIdle(idle);
        const scheduler = Effect.runSync(
          createScheduler({
            stateRoot: local,
            schedules: [],
            now: () => now,
            agent: {
              async *invoke() {
                entered.resolve();
                await finishTurn.promise;
                await writeFile(join(local, "sessions/s.jsonl"), after);
                yield { type: "text", delta: "done" };
                yield { type: "completed" };
              },
            },
          }),
        );
        try {
          scheduler.start();
          await entered.promise;
          // If admission emitted idle, freeze that already-packed upload until the turn has settled.
          if (idle.mock.calls.length > 0) await putStarted.promise;
          scheduler.stop();
          finishTurn.resolve();
          const auditPath = join(local, "schedule/runs.jsonl");
          await vi.waitFor(async () =>
            expect(JSON.parse(await readFile(auditPath, "utf8"))).toMatchObject({
              outcome: "completed",
              reply: "done",
            }),
          );
          await putStarted.promise;
          finishPut.resolve();
          await sync.flush();
          const puts = calls.filter((c) => c.method === "PUT");
          expect(puts).toHaveLength(1);
          expect(JSON.parse(gunzipSync(puts[0]!.body!).toString()).files).toMatchObject({
            "sessions/s.jsonl": Buffer.from(after).toString("base64"),
            "schedule/runs.jsonl": (await readFile(auditPath)).toString("base64"),
          });
          expect(alarmFetch).not.toHaveBeenCalled();
        } finally {
          off();
          setWakeupsSink(undefined);
          scheduler.stop();
          finishTurn.resolve();
          finishPut.resolve();
          await sync.flush();
        }
      },
    );

    it("does not overwrite newer envelope URLs with a late refresh response", async () => {
      const local = await stateRoot();
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const { impl, calls } = fakeFetch(async (_url, init) => {
        if (init?.method === "POST") {
          entered.resolve();
          await finish.promise;
          return Response.json({ getUrl: "https://s3/old-get", putUrl: "https://s3/old-put" });
        }
        return new Response(null, { status: init?.method === "GET" ? 404 : 200 });
      });
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use({ ...urls, refresh: { url: "https://forwarder/refresh", auth: "secret" } });
      await sync.ready();
      sync.save();
      await entered.promise;
      sync.use({ getUrl: "https://s3/new-get", putUrl: "https://s3/new-put" });
      finish.resolve();
      await sync.flush();
      expect(calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual(["https://s3/new-put"]);
    });

    it("serializes fresh checkpoints behind a save without resaving its own idle edge", async () => {
      const local = await stateRoot({ "intent.json": "old" });
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let active = 0,
        peak = 0;
      const { impl, calls } = fakeFetch(async (_url, init) => {
        if (init?.method === "PUT") {
          active++;
          peak = Math.max(peak, active);
          if (calls.filter((c) => c.method === "PUT").length === 1) {
            entered.resolve();
            await finish.promise;
          }
          active--;
        }
        return new Response(null, { status: init?.method === "GET" ? 404 : 200 });
      });
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);
      await sync.ready();
      const off = onIdle(() => sync.save());
      try {
        sync.save();
        await entered.promise;
        await writeFile(join(local, "intent.json"), "new");
        const checkpoints = [sync.checkpoint(), sync.checkpoint()];
        finish.resolve();
        expect(await Promise.all(checkpoints)).toEqual([{ written: true }, { written: true }]);
        await sync.flush();
        const puts = calls.filter((c) => c.method === "PUT");
        expect(puts).toHaveLength(3);
        expect(peak).toBe(1);
        for (const put of puts.slice(1)) {
          expect(JSON.parse(gunzipSync(put.body!).toString()).files["intent.json"]).toBe(
            Buffer.from("new").toString("base64"),
          );
        }
      } finally {
        off();
        finish.resolve();
        await sync.flush();
      }
    });

    it("uses the captured deadline and joins a late PUT failure before releasing busy ownership", async () => {
      const local = await stateRoot();
      const base = activeWork();
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const aborted = vi.fn();
      const errors = vi.spyOn(log, "error").mockImplementation(() => {});
      let fail = true;
      const { impl, calls } = fakeFetch(async (_url, init) => {
        if (init?.method === "PUT" && fail) {
          init.signal?.addEventListener("abort", aborted, { once: true });
          entered.resolve();
          await finish.promise;
          throw new Error("late PUT failure");
        }
        return new Response(null, { status: init?.method === "GET" ? 404 : 200 });
      });
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const sync = yield* stateSync({ stateRoot: local, fetchImpl: impl });
            sync.use(urls);
            yield* Effect.promise(() => sync.ready());
            sync.save();
            yield* Effect.promise(() => entered.promise);
            yield* TestClock.adjust(60_000);
            expect(aborted).toHaveBeenCalledOnce();
            expect(activeWork()).toBe(base + 1);
            finish.resolve();
            yield* Effect.promise(() => sync.flush());
            expect(activeWork()).toBe(base);
            expect(errors).toHaveBeenCalledOnce();
            expect(errors).toHaveBeenCalledWith(expect.stringContaining("TimeoutError"));
            fail = false;
            sync.save();
            yield* Effect.promise(() => sync.flush());
            expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
          }).pipe(Effect.provide(TestClock.layer())),
        );
      } finally {
        finish.resolve();
        errors.mockRestore();
      }
    });
    it("restores on the first ready() and pushes the packed root on save()", async () => {
      const remote = await packStateRoot(await stateRoot({ "sessions/a.jsonl": "history" }));
      const local = await stateRoot();
      const { impl, calls } = fakeFetch((_url, init) =>
        init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(new Uint8Array(remote)),
      );
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });

      sync.use(urls);
      await sync.ready();
      expect(await readFile(join(local, "sessions/a.jsonl"), "utf8")).toBe("history");

      sync.save();
      await sync.flush();
      expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
      expect(calls[1]!.body!.byteLength).toBeGreaterThan(0);
    });

    it("re-mints presigned URLs immediately before a late snapshot PUT", async () => {
      const local = await stateRoot({ "sessions/a.jsonl": "history" });
      const expiring = {
        ...urls,
        refresh: { url: "https://forwarder/__fastagent/state-urls", auth: "refresh-secret" },
      };
      const { impl, calls } = fakeFetch((url, init) => {
        if (url === expiring.refresh.url) {
          return Response.json({ getUrl: "https://s3/fresh-get", putUrl: "https://s3/fresh-put" });
        }
        return new Response(null, { status: init?.method === "PUT" ? 200 : 404 });
      });
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(expiring);
      await sync.ready();
      sync.save();
      await sync.flush();

      expect(calls.map(({ url, method }) => [method, url])).toEqual([
        ["GET", "https://s3/get"],
        ["POST", "https://forwarder/__fastagent/state-urls"],
        ["PUT", "https://s3/fresh-put"],
      ]);
    });

    it("a 404 is first boot (empty root, no error) — and only then may a snapshot be written", async () => {
      const local = await stateRoot();
      const { impl, calls } = fakeFetch((_u, init) =>
        init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(null, { status: 404 }),
      );
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);
      await expect(sync.ready()).resolves.toBeUndefined();
      sync.save();
      await sync.flush();
      expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    });

    it("a 403 is NOT first boot — it rejects with the ListBucket/expiry diagnosis instead of serving empty", async () => {
      // S3 answers 403 for a missing key when the signer lacks s3:ListBucket — indistinguishable from
      // a revoked permission, under which the snapshot may well EXIST. Treating it as "absent" would
      // boot an empty agent and overwrite the real snapshot; the error must say what to check instead.
      const local = await stateRoot();
      const { impl, calls } = fakeFetch(() => new Response("AccessDenied", { status: 403 }));
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);

      await expect(sync.ready()).rejects.toThrow(/GET failed: 403.*s3:ListBucket/);
      sync.save();
      await sync.flush();
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    });

    it("a FAILED restore rejects and blocks saving — never overwrite good state with an empty root", async () => {
      const local = await stateRoot();
      const { impl, calls } = fakeFetch(() => new Response("boom", { status: 500 }));
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);

      await expect(sync.ready()).rejects.toThrow(/GET failed: 500/);
      await expect(sync.ready()).rejects.toThrow(/GET failed: 500/); // sticky: one attempt per process
      sync.save();
      await sync.flush();
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    });

    it("without URLs nothing happens — a direct invoke must not read or clobber the ingress snapshot", async () => {
      const { impl, calls } = fakeFetch(() => new Response(null, { status: 404 }));
      const sync = createStateSync({ stateRoot: await stateRoot(), fetchImpl: impl });

      expect(sync.configured()).toBe(false);
      await expect(sync.ready()).resolves.toBeUndefined();
      sync.save();
      await sync.flush();
      expect(calls).toHaveLength(0);

      // …and the skipped restore is not cached: the first envelope that DOES carry URLs still runs it.
      sync.use(urls);
      expect(sync.configured()).toBe(true);
      await sync.ready();
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    });

    it("coalesces saves: a burst while one upload is in flight collapses to ONE follow-up", async () => {
      const local = await stateRoot({ "a.json": "1" });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const { impl, calls } = fakeFetch(async (_u, init) => {
        if (init?.method === "PUT" && calls.filter((c) => c.method === "PUT").length === 1) await gate;
        return new Response(init?.method === "PUT" ? null : new Uint8Array(await packStateRoot(local)), {
          status: 200,
        });
      });
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);
      await sync.ready();

      sync.save(); // starts, blocks on the gate
      sync.save();
      sync.save();
      sync.save(); // three more requests while it is in flight
      release();
      await sync.flush();

      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2); // the in-flight one + one catch-up
    });

    it("counts the upload as in-flight work — the platform may reclaim the microVM the instant it idles", async () => {
      const local = await stateRoot({ "a.json": "1" });
      const base = activeWork();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const { impl } = fakeFetch(async (_u, init) => {
        if (init?.method === "PUT") await gate;
        return new Response(init?.method === "PUT" ? null : null, { status: init?.method === "PUT" ? 200 : 404 });
      });
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);
      await sync.ready();

      sync.save();
      await vi.waitFor(() => expect(activeWork()).toBe(base + 1)); // /ping still says HealthyBusy
      release();
      await sync.flush();
      expect(activeWork()).toBe(base);
    });

    describe("checkpoint (the pre-stop flush)", () => {
      it("writes a FRESH snapshot and says so — the caller is about to lose this process", async () => {
        const local = await stateRoot({ "a.json": "1" });
        const { impl, calls } = fakeFetch((_u, init) =>
          init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(null, { status: 404 }),
        );
        const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
        sync.use(urls);
        await sync.ready();

        // A turn's durable intent lands AFTER the last idle-edge upload — the checkpoint must carry it.
        await writeFile(join(local, "turns.json"), '{"pending":"the interrupted turn"}');
        expect(await sync.checkpoint()).toEqual({ written: true });

        const put = calls.filter((c) => c.method === "PUT").at(-1)!;
        const sent = JSON.parse(gunzipSync(Buffer.from(put.body!)).toString());
        expect(sent.files["turns.json"]).toBeDefined();
      });

      it("reports written:false with a REASON rather than claiming a protection it did not give", async () => {
        // No URLs: this process never served a forwarder envelope (a session started by the
        // checkpoint itself). Nothing of the shared state to write — but the caller must not be told
        // an in-flight turn was protected.
        const bare = createStateSync({ stateRoot: await stateRoot(), fetchImpl: fakeFetch(() => new Response()).impl });
        expect(await bare.checkpoint()).toMatchObject({ written: false, reason: expect.stringContaining("forwarder") });

        // URLs, but a failed restore: writing now would overwrite a good snapshot with a blank root.
        const { impl } = fakeFetch(() => new Response("boom", { status: 500 }));
        const broken = createStateSync({ stateRoot: await stateRoot(), fetchImpl: impl });
        broken.use(urls);
        await expect(broken.ready()).rejects.toThrow();
        expect(await broken.checkpoint()).toMatchObject({ written: false });
      });

      it("THROWS when the upload fails — unlike save(), the whole point of the call is to know", async () => {
        const local = await stateRoot({ "a.json": "1" });
        const { impl } = fakeFetch((_u, init) =>
          init?.method === "PUT" ? new Response(null, { status: 403 }) : new Response(null, { status: 404 }),
        );
        const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
        sync.use(urls);
        await sync.ready();
        await expect(sync.checkpoint()).rejects.toThrow(/PUT failed: 403/);
        // …and the failure leaves the sync usable rather than wedged.
        await expect(sync.flush()).resolves.toBeUndefined();
      });
    });

    it("an upload failure is logged, not thrown — the local mount still holds the data until next settle", async () => {
      const local = await stateRoot({ "a.json": "1" });
      const { impl } = fakeFetch((_u, init) =>
        init?.method === "PUT"
          ? new Response("private snapshot response", { status: 403 })
          : new Response(null, { status: 404 }),
      );
      const sync = createStateSync({ stateRoot: local, fetchImpl: impl });
      sync.use(urls);
      await sync.ready();

      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      sync.save();
      await expect(sync.flush()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("state snapshot PUT failed: 403"));
      expect(spy.mock.calls.flat().join(" ")).not.toContain("private snapshot response");
      spy.mockRestore();
    });
  });
});
