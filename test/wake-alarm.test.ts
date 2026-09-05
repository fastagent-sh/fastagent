import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import { scheduleFile, writeScheduleFile } from "../src/schedule/state.ts";
import { RESERVED_PATHS, type WakeAlarmRequest } from "../src/channels/agentcore-protocol.ts";
import {
  MAX_SYNC_ATTEMPTS,
  createWakeAlarmSink,
  readWakeAlarmUrl,
  rememberWakeAlarmUrl,
  toAlarms,
} from "../src/schedule/wake-alarm.ts";
import { type Wakeup, addWakeup, removeWakeup, setWakeupsSink, takeFirstDueWakeup } from "../src/schedule/wakeups.ts";

const freshRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "fa-wake-alarm-"));

/** Write the wakeups store directly — the sink reads it, and this bypasses addWakeup's guardrails
 *  so a test can stage past/impossible fireAts. */
const seed = (root: string, wakeups: Wakeup[]): void => writeScheduleFile(scheduleFile(root, "wakeups"), wakeups);

/** A sink whose POSTs fail until `succeed()`, parked between attempts until `release()` — the window
 *  where a store mutation must reach the loop. */
function retryingSink(now = new Date("2026-07-28T09:00:00Z")) {
  const posted: WakeAlarmRequest[] = [];
  let failing = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const impl = vi.fn(async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)) as WakeAlarmRequest);
    return failing ? new Response("boom", { status: 500 }) : new Response("ok");
  });
  const sink = createWakeAlarmSink({
    secret: "x",
    fetchImpl: impl as unknown as typeof fetch,
    now: () => now,
    delay: () => gate,
  });
  return {
    sink,
    posted,
    succeed: () => {
      failing = false;
    },
    release: () => release(),
  };
}

afterEach(() => {
  setWakeupsSink(undefined);
  vi.restoreAllMocks();
});

/** A fetch fake that records calls and resolves 200. */
function fakeFetch(status = 200) {
  const calls: { url: string; body: WakeAlarmRequest }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as WakeAlarmRequest });
    return new Response("ok", { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("schedule/wake-alarm: the URL store", () => {
  it("remembers the forwarder URL (write-if-changed) and reads it back", async () => {
    const root = await freshRoot();
    expect(readWakeAlarmUrl(root)).toBeUndefined();
    rememberWakeAlarmUrl(root, "https://fn.on.aws/");
    expect(readWakeAlarmUrl(root)).toBe("https://fn.on.aws/");
    rememberWakeAlarmUrl(root, "https://fn.on.aws/"); // unchanged — no churn (no throw is the contract)
    expect(readWakeAlarmUrl(root)).toBe("https://fn.on.aws/");
  });
});

describe("schedule/wake-alarm: the sink", () => {
  it("POSTs the pending set (declarative reconcile) to the reserved path with the secret", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws/");
    const { impl, calls } = fakeFetch();
    const sink = createWakeAlarmSink({
      secret: "s3cret",
      fetchImpl: impl,
      now: () => new Date("2026-07-28T09:00:00Z"),
    });
    seed(root, [
      { id: "a", session: "s", prompt: "p", fireAt: "2026-07-28T10:00:00.000Z" },
      { id: "b", session: "s", prompt: "q", fireAt: "2026-07-28T11:00:00.000Z", cron: "0 * * * *" },
    ]);
    sink(root);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(`https://fn.on.aws${RESERVED_PATHS.wakeAlarm}`); // trailing slash normalized
    expect(calls[0]!.body).toEqual({
      secret: "s3cret",
      alarms: [
        { id: "a", at: "2026-07-28T10:00:00.000Z" },
        { id: "b", at: "2026-07-28T11:00:00.000Z" },
      ],
    });
  });

  it("filters already-due alarms (the awake box handles those) and skips an all-due/empty set", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    const { impl, calls } = fakeFetch();
    const sink = createWakeAlarmSink({ secret: "x", fetchImpl: impl, now: () => new Date("2026-07-28T10:00:00Z") });
    seed(root, [
      { id: "due", session: "s", prompt: "p", fireAt: "2026-07-28T09:59:00.000Z" }, // past — filtered
      { id: "future", session: "s", prompt: "p", fireAt: "2026-07-28T10:30:00.000Z" },
    ]);
    sink(root);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.alarms).toEqual([{ id: "future", at: "2026-07-28T10:30:00.000Z" }]);
    seed(root, [{ id: "due", session: "s", prompt: "p", fireAt: "2026-07-28T09:59:00.000Z" }]); // nothing future
    sink(root);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1); // no empty POST — deletion is lazy by design
  });

  it("re-reads the store between attempts — a mutation mid-retry redirects the loop to the new set", async () => {
    // The reason the loop carries no payload: a retry that keeps re-POSTing the set it started with
    // would need an ordering rule to decide which of two in-flight views wins. There is only one.
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    seed(root, [{ id: "a", session: "s", prompt: "p", fireAt: "2026-07-28T10:00:00.000Z" }]);
    const { sink, posted, succeed, release } = retryingSink();
    sink(root);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.alarms).toEqual([{ id: "a", at: "2026-07-28T10:00:00.000Z" }]);

    seed(root, [{ id: "b", session: "s", prompt: "p", fireAt: "2026-07-28T11:00:00.000Z" }]);
    succeed();
    sink(root);
    release();

    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.alarms).toEqual([{ id: "b", at: "2026-07-28T11:00:00.000Z" }]); // `a` is gone
  });

  it("single-flight: a burst of mutations coalesces into ONE more pass, not one loop each", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    seed(root, [{ id: "a", session: "s", prompt: "p", fireAt: "2026-07-28T10:00:00.000Z" }]);
    const { sink, posted, succeed, release } = retryingSink();
    sink(root);
    await vi.waitFor(() => expect(posted).toHaveLength(1)); // parked mid-retry

    succeed();
    for (let i = 0; i < 3; i++) sink(root); // three saves land while the loop is parked
    expect(posted).toHaveLength(1); // none of them started a loop of its own
    release();

    await vi.waitFor(() => expect(posted).toHaveLength(2)); // one re-read covers all three
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(posted).toHaveLength(2);
  });

  it("a cancel mid-retry converges silently — the abandoned set is never re-POSTed", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    seed(root, [{ id: "a", session: "s", prompt: "p", fireAt: "2026-07-28T10:00:00.000Z" }]);
    const { sink, posted, succeed, release } = retryingSink();
    sink(root);
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    seed(root, []); // unwake landed while the loop was parked
    succeed();
    sink(root);
    release();

    // "It must not re-post" is a negative, so the wait is bounded by event-loop TURNS, not wall
    // clock: the parked loop needs one to resume, re-read, and find nothing to mirror.
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(posted).toHaveLength(1); // no empty POST either — deletion is lazy by design
  });

  it("retries a failed sync with backoff (counted as in-flight work), then gives up loudly", async () => {
    const { activeWork } = await import("../src/channels/busy.ts");
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    const base = activeWork();
    let sawBusy = false;
    const attempts: number[] = [];
    const failing = vi.fn(async () => {
      attempts.push(Date.now());
      sawBusy = sawBusy || activeWork() > base; // the retry window counts as in-flight work
      return new Response("boom", { status: 500 });
    });
    const sink = createWakeAlarmSink({
      secret: "x",
      fetchImpl: failing as unknown as typeof fetch,
      now: () => new Date("2026-07-28T09:00:00Z"),
      delay: async () => {}, // no real waiting in tests
    });
    seed(root, [{ id: "a", session: "s", prompt: "p", fireAt: "2026-07-28T10:00:00.000Z" }]);
    sink(root);
    await vi.waitFor(() => expect(attempts.length).toBe(MAX_SYNC_ATTEMPTS));
    expect(sawBusy).toBe(true);
    await vi.waitFor(() => expect(activeWork()).toBe(base)); // released after giving up
  });

  it("a store mutating faster than the backoff cannot renew the retry budget", async () => {
    // Each mutation restarts the attempt SEQUENCE against the new desired set, but not the budget:
    // counting failures only within a pass, a save landing inside every backoff would keep the loop
    // alive forever and the one loud give-up line — the only non-filterable signal that the forwarder
    // is down — would never be reached. Reverting to a per-pass counter hangs this test.
    const { activeWork } = await import("../src/channels/busy.ts");
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    const base = activeWork();
    let attempts = 0;
    const failing = vi.fn(async () => {
      attempts++;
      return new Response("boom", { status: 500 });
    });
    let sink: (stateRoot: string) => void = () => {};
    sink = createWakeAlarmSink({
      secret: "x",
      fetchImpl: failing as unknown as typeof fetch,
      now: () => new Date("2026-07-28T09:00:00Z"),
      delay: async () => sink(root), // a save lands inside every single backoff
    });
    seed(root, [{ id: "a", session: "s", prompt: "p", fireAt: "2026-07-28T10:00:00.000Z" }]);
    sink(root);
    await vi.waitFor(() => expect(activeWork()).toBe(base)); // it gave up instead of spinning
    expect(attempts).toBe(MAX_SYNC_ATTEMPTS);
  });

  it("is a no-op (warned, not thrown) when the forwarder URL is unavailable", async () => {
    const root = await freshRoot();
    const { impl, calls } = fakeFetch();
    // A FUTURE wake-up: an empty store converges before the URL is ever read, so it would not reach
    // the branch under test.
    seed(root, [{ id: "a", session: "s", prompt: "p", fireAt: new Date(Date.now() + 3_600_000).toISOString() }]);
    createWakeAlarmSink({ secret: "x", fetchImpl: impl })(root);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });

  it("wired via setWakeupsSink: every store mutation re-mirrors — add, claim-advance, remove", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    const { impl, calls } = fakeFetch();
    const now = new Date("2026-07-28T10:00:00Z");
    setWakeupsSink(createWakeAlarmSink({ secret: "x", fetchImpl: impl, now: () => now }));

    // The one-shot fires LATER than the recurring's first slot, so the claim below takes the recurring.
    const added = addWakeup(root, { session: "s", prompt: "p", fireAt: new Date("2026-07-28T13:00:00Z") }, now);
    expect(added.ok).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.alarms).toHaveLength(1);

    // A recurring wake's CLAIM advances fireAt in place — the save re-arms its alarm for the next slot.
    const rec = addWakeup(root, { session: "s", prompt: "r", cron: "0 * * * *", tz: "UTC" }, now);
    expect(rec.ok).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    takeFirstDueWakeup(root, new Date("2026-07-28T11:00:01Z")); // claims the recurring occurrence
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    const rearmed = calls[2]!.body.alarms.find((a) => a.id === (rec as { id: string }).id);
    expect(rearmed?.at).toBe("2026-07-28T12:00:00.000Z"); // advanced to the NEXT cron instant

    // unwake mirrors too (the cancelled alarm goes stray and self-deletes on fire — lazy by design).
    removeWakeup(root, (added as { id: string }).id);
    await vi.waitFor(() => expect(calls).toHaveLength(4));
  });

  it("an unreadable store is reported, not thrown — nothing awaits the loop", async () => {
    // `listWakeups` throws by design on a read fault (state.ts), and it now runs INSIDE the async
    // loop: without the sink terminating its own errors this is an unhandled rejection, which Node
    // turns into a dead container — on the one path a broken state mount guarantees.
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    mkdirSync(scheduleFile(root, "wakeups"), { recursive: true }); // a directory where the file goes: EISDIR
    const errors: string[] = [];
    vi.spyOn(log, "error").mockImplementation((m: string) => void errors.push(m));
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      const { impl, calls } = fakeFetch();
      createWakeAlarmSink({ secret: "x", fetchImpl: impl })(root);
      await vi.waitFor(() => expect(errors.some((m) => m.includes("reconcile failed"))).toBe(true));
      expect(calls).toHaveLength(0);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("a failing sink never breaks the store write", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    setWakeupsSink(() => {
      throw new Error("boom");
    });
    const added = addWakeup(
      root,
      { session: "s", prompt: "p", fireAt: new Date("2026-07-28T10:30:00Z") },
      new Date("2026-07-28T10:00:00Z"),
    );
    expect(added.ok).toBe(true); // the write survived the sink throw
  });
});

describe("schedule/wake-alarm: boot reconcile", () => {
  it("re-mirrors pending wake-ups once at start; silent when none", async () => {
    const root = await freshRoot();
    rememberWakeAlarmUrl(root, "https://fn.on.aws");
    addWakeup(
      root,
      { session: "s", prompt: "p", fireAt: new Date("2099-07-28T10:30:00Z") }, // far future — survives the due filter under the real clock
      new Date("2099-07-28T10:00:00Z"),
    );
    const { impl, calls } = fakeFetch();
    createWakeAlarmSink({ secret: "x", fetchImpl: impl })(root); // what `start` calls at boot
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const empty = await freshRoot();
    const quiet = fakeFetch();
    createWakeAlarmSink({ secret: "x", fetchImpl: quiet.impl })(empty);
    await new Promise((r) => setTimeout(r, 20));
    expect(quiet.calls).toHaveLength(0);
  });
});

describe("schedule/wake-alarm: helpers", () => {
  it("toAlarms mirrors id + fireAt for FUTURE entries only", () => {
    const now = new Date("2026-07-28T10:00:00Z");
    const entries: Wakeup[] = [
      { id: "future", session: "s", prompt: "p", fireAt: "2026-07-28T11:00:00.000Z" },
      { id: "due", session: "s", prompt: "p", fireAt: "2026-07-28T10:00:01.000Z" }, // inside the due margin
    ];
    expect(toAlarms(entries, now)).toEqual([{ id: "future", at: "2026-07-28T11:00:00.000Z" }]);
  });
});
