import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import type { Agent, AgentEvent } from "../src/agent.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";
import { claimSlot, readFires } from "../src/schedule/state.ts";
import { createTriggerHandler } from "../src/schedule/trigger.ts";

// Counted, not faked: croner is synchronous and this route is anonymous, so how OFTEN it reads the
// grid is part of the contract.
const searches = vi.hoisted(() => ({ n: 0 }));
vi.mock("../src/schedule/cron.ts", async (real) => {
  const actual = await real<typeof import("../src/schedule/cron.ts")>();
  return {
    ...actual,
    nextRun: (...args: Parameters<typeof actual.nextRun>) => {
      searches.n += 1;
      return actual.nextRun(...args);
    },
  };
});

/**
 * `POST /trigger` — the external clock's half of a time trigger. The FIRE itself is `fireScheduleOnce`
 * and is covered in scheduler.test.ts; what belongs here is the wire: what the body may say, which
 * occurrence a delivery is for, and what each outcome looks like to the clock that called.
 *
 * THE DIVISION OF LABOUR is what these cases are about: the CLOCK names the occurrence (only it knows
 * which of its attempts are one fire), and this route runs it at most once per name, refuses what is
 * too stale to be worth running, and reports which happened.
 */

const hourly = (over: Partial<LoadedSchedule> = {}): LoadedSchedule => ({
  name: "digest",
  cron: "0 * * * *",
  tz: "UTC",
  prompt: "summarise",
  ...over,
});

/** Records each turn and yields the scripted terminal. */
function recordingAgent(events: AgentEvent[] = [{ type: "completed" }]) {
  const calls: { session: string; text: string }[] = [];
  const agent: Agent = {
    async *invoke(scope, prompt) {
      calls.push({ session: scope.session, text: prompt.text });
      for (const e of events) yield e;
    },
  };
  return { agent, calls };
}

const stateRoot = () => mkdtemp(join(tmpdir(), "fa-trigger-"));

const handlerFor = async (schedules: LoadedSchedule[], agent: Agent) => {
  const root = await stateRoot();
  const handle = createTriggerHandler({ agent, stateRoot: root, schedules });
  return { root, handle };
};

const trigger = (handle: (req: Request) => Promise<Response>, body: unknown, init: RequestInit = {}) =>
  handle(
    new Request("http://h/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
  );

/** The instant every fixture's clock reads unless a case moves it: half past the `hourly()` occurrence. */
const NOW = "2026-07-07T10:30:00.000Z";

describe("schedule/trigger: POST /trigger", () => {
  // PINNED, because THIS serve's clock is what picks the occurrence — every expectation below is a
  // grid point measured from it.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it("fires the schedule the definition wrote down, for the occurrence the CLOCK named", async () => {
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    const res = await trigger(handle!, { name: "digest", occurrence: "2026-07-07T10:00:00Z" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fired: true, slot: "2026-07-07T10:00:00.000Z" });
    // The PROMPT came from the definition, not the wire — that is the whole reason this route exists
    // beside `POST /invoke`, which would have carried one.
    expect(calls).toEqual([{ session: "schedule:digest", text: "summarise" }]);
    expect(readFires(root, "digest").map((f) => f.slot)).toEqual(["2026-07-07T10:00:00.000Z"]);
  });

  it("a REDELIVERY is one fire — measured EventBridge backoff, replayed both ways", async () => {
    // THE measurement this design is built on: EventBridge redelivered one fire at +60s and +186s, with
    // a byte-identical payload (3 attempts, ap-southeast-1). A receiver that snapped its OWN clock to
    // the grid would have named those later arrivals differently and run the turn again. The clock's
    // name is what makes them one fire.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    const fire = { name: "digest", occurrence: "2026-07-07T10:00:00Z" };

    vi.setSystemTime(new Date("2026-07-07T10:00:00.400Z"));
    expect(await (await trigger(handle!, fire)).json()).toMatchObject({ fired: true });
    for (const afterMs of [60_200, 186_400]) {
      vi.setSystemTime(new Date(Date.parse("2026-07-07T10:00:00.400Z") + afterMs));
      const retry = (await (await trigger(handle!, fire)).json()) as { fired: boolean; skippedReason?: string };
      expect({ afterMs, fired: retry.fired }).toEqual({ afterMs, fired: false });
      expect(retry.skippedReason).toContain("already claimed");
    }
    expect(calls).toHaveLength(1);
    expect(readFires(root, "digest").map((f) => f.slot)).toEqual(["2026-07-07T10:00:00.000Z"]);
  });

  it("…and on a MINUTE cron that same backoff is past the window, so the occurrence is dropped", async () => {
    // The accepted cost, stated as a test. EventBridge's backoff exceeds a 60s period, so a minute cron
    // whose first delivery never landed loses that minute instead of catching it up. That is the right
    // trade for a minute cron — the next minute is 60s away — and the point is what does NOT happen:
    // the late retry is not renamed onto a later occurrence and run as if it were that one.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly({ cron: "* * * * *" })], agent);
    vi.setSystemTime(new Date(Date.parse("2026-07-07T10:30:00.400Z") + 186_400));
    const late = (await (await trigger(handle!, { name: "digest", occurrence: "2026-07-07T10:30:00Z" })).json()) as {
      fired: boolean;
      slot: string;
      skippedReason?: string;
    };

    expect(late.fired).toBe(false);
    expect(late.skippedReason).toContain("was superseded at");
    expect(late.slot).toBe("2026-07-07T10:30:00.000Z"); // still ITS occurrence, not the one it landed in
    expect(calls).toEqual([]);
    expect(readFires(root, "digest")).toEqual([]); // nothing claimed, so nothing burned
  });

  it("an UNNAMED delivery is its own occurrence, and the second one in the same interval is not", async () => {
    // A crontab's `curl` has nothing to name, so the delivery IS the occurrence. What keeps that from
    // being a blank cheque on an anonymous route is the same ceiling a named caller meets.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);

    vi.setSystemTime(new Date("2026-07-07T10:00:03Z"));
    expect(await (await trigger(handle!, { name: "digest" })).json()).toMatchObject({ fired: true });
    for (const t of ["2026-07-07T10:17:31Z", "2026-07-07T10:59:59Z"]) {
      vi.setSystemTime(new Date(t));
      const again = (await (await trigger(handle!, { name: "digest" })).json()) as { skippedReason?: string };
      expect(String(again.skippedReason)).toContain("is not a new occurrence");
    }
    expect(calls).toHaveLength(1);
    expect(readFires(root, "digest").map((f) => f.slot)).toEqual(["2026-07-07T10:00:03.000Z"]);

    // Past the next occurrence, it is a new fire again.
    vi.setSystemTime(new Date("2026-07-07T11:00:02Z"));
    expect(await (await trigger(handle!, { name: "digest" })).json()).toMatchObject({ fired: true });
    expect(calls).toHaveLength(2);
  });

  it("a NAMED occurrence cannot be walked forward a millisecond at a time to buy turns", async () => {
    // The hole this closes. `claimSlot` refuses only a name it already holds or one older than its
    // newest, so incrementing `occurrence` by 1ms minted a fresh name every time: 20 requests to a
    // `0 9 * * *` schedule ran 20 full model turns. The route is anonymous, and the posture this
    // feature recommends (`http.invoke: false` + `http.trigger: true`) makes it the ONLY anonymous way
    // to start one, so its ceiling has to be the schedule's own rate.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly({ cron: "0 9 * * *" })], agent);
    const base = Date.parse("2026-07-07T09:00:00Z");
    for (let i = 0; i < 20; i++) {
      const res = await trigger(handle!, { name: "digest", occurrence: new Date(base + i).toISOString() });
      expect(res.status).toBe(200);
    }
    expect(calls).toHaveLength(1);
    expect(readFires(root, "digest")).toHaveLength(1);
  });

  it("ONE STEP ON THE GRID, not a duration — an uneven cron gets each gap right", async () => {
    // `0 9 * * 1-5`: Friday's occurrence is followed by Monday's (three days), Monday's by Tuesday's
    // (one). A single measured period would be wrong for one of them in both directions — letting a
    // Friday fire again on Saturday, or refusing Tuesday because Monday's gap was read as three days.
    const { agent, calls } = recordingAgent();
    const weekday = hourly({ cron: "0 9 * * 1-5" });
    const { handle } = await handlerFor([weekday], agent);

    vi.setSystemTime(new Date("2026-07-10T09:00:04Z")); // Friday
    expect(await (await trigger(handle!, { name: "digest" })).json()).toMatchObject({ fired: true });
    // Saturday and Sunday are inside Friday's occurrence — no new fire.
    vi.setSystemTime(new Date("2026-07-11T09:00:04Z"));
    expect(await (await trigger(handle!, { name: "digest" })).json()).toMatchObject({ fired: false });
    expect(calls).toHaveLength(1);
    // Monday is.
    vi.setSystemTime(new Date("2026-07-13T09:00:04Z"));
    expect(await (await trigger(handle!, { name: "digest" })).json()).toMatchObject({ fired: true });
    // …and so is Tuesday, one day later, which a three-day period would have refused.
    vi.setSystemTime(new Date("2026-07-14T09:00:04Z"));
    expect(await (await trigger(handle!, { name: "digest" })).json()).toMatchObject({ fired: true });
    expect(calls).toHaveLength(3);
  });

  it("an occurrence the next one has already superseded is reported, not run — a stale turn is WRONG", async () => {
    // Not a defence bolted on: a scheduled agent turn is tied to when it runs, and "summarise today"
    // six hours late is a wrong digest, not a late one (k8s says it with startingDeadlineSeconds).
    // "Superseded" rather than a duration, because the duration differs per occurrence on an uneven cron.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);

    const stale = (await (await trigger(handle!, { name: "digest", occurrence: "2026-07-07T08:00:00Z" })).json()) as {
      fired: boolean;
      skippedReason?: string;
    };
    expect(stale.fired).toBe(false);
    expect(stale.skippedReason).toContain("was superseded at");
    expect(calls).toEqual([]);
    expect(readFires(root, "digest")).toEqual([]); // nothing claimed, so nothing burned

    // The current occurrence is not superseded — the clock has not reached the next one.
    expect(await (await trigger(handle!, { name: "digest", occurrence: "2026-07-07T10:00:00Z" })).json()).toMatchObject(
      { fired: true },
    );

    // The window is the SCHEDULE's own gap, not a constant: the same 90-minute lateness that supersedes
    // an hourly occurrence leaves a daily one with 22 hours to spare.
    const { handle: daily, root: dailyRoot } = await handlerFor([hourly({ cron: "0 9 * * *" })], agent);
    expect(await (await trigger(daily!, { name: "digest", occurrence: "2026-07-07T09:00:00Z" })).json()).toMatchObject({
      fired: true,
    });
    expect(readFires(dailyRoot, "digest")).toHaveLength(1);
  });

  it("refuses an occurrence ahead of this clock — it cannot have been delivered yet", async () => {
    // Not a skew tolerance question: the caller and this container disagree about the time, and only
    // one can be believed here. Refusing is self-healing BECAUSE the name belongs to the clock — the
    // retry carries the same one, by which time this clock has moved.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    for (const ahead of ["2999-01-01T00:00:00Z", new Date(Date.now() + 30_000).toISOString()]) {
      const res = await trigger(handle!, { name: "digest", occurrence: ahead });
      expect({ ahead, status: res.status }).toEqual({ ahead, status: 400 });
      const said = await res.text();
      expect(said).toContain("ahead of this machine's clock");
      expect(said).not.toContain(ahead); // the caller's string is never quoted back
    }
    expect(readFires(root, "digest")).toEqual([]);
    expect(calls).toEqual([]);

    // …and the real occurrence still fires afterwards.
    expect(await (await trigger(handle!, { name: "digest", occurrence: "2026-07-07T10:00:00Z" })).json()).toMatchObject(
      { fired: true },
    );
  });

  it("a refused delivery costs no cron evaluation — the ceiling is cached against the claim it came from", async () => {
    // croner is synchronous and this route is anonymous, so how often it reads the grid is part of the
    // contract. The flood the ceiling exists to refuse must be the cheap path, not the expensive one.
    const { agent } = recordingAgent();
    const { handle } = await handlerFor([hourly()], agent);
    expect((await trigger(handle!, { name: "digest" })).status).toBe(200);

    searches.n = 0;
    for (let i = 0; i < 50; i++) expect((await trigger(handle!, { name: "digest" })).status).toBe(200);
    expect(searches.n).toBe(0);
  });

  it("clips the name it quotes back — the one place this route echoes an unauthenticated caller", async () => {
    const { handle } = await handlerFor([hourly()], recordingAgent().agent);
    const res = await trigger(handle!, { name: "x".repeat(4000) });
    expect(res.status).toBe(404);
    const said = await res.text();
    expect(said).toContain("x".repeat(64));
    expect(said).not.toContain("x".repeat(65));
    expect(said).toContain("this deployment has: digest"); // listing OUR names is the deliberate part
  });

  it("an occurrence the state root has moved past is reported, not fired", async () => {
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    const newer = new Date("2026-07-07T12:00:00Z");
    claimSlot(root, "digest", newer, newer);

    const res = await trigger(handle!, { name: "digest" });
    expect(res.status).toBe(200); // the DELIVERY succeeded; the occurrence is what was skipped
    expect(await res.json()).toMatchObject({ fired: false });
    expect(calls).toEqual([]);
  });

  it("names the schedules it does have when the caller names one it does not", async () => {
    // Deploy drift: an external clock rule outliving the schedule it fires for. Listing the names is
    // what lets an operator tell a typo from a stale rule without shelling into the box.
    const { handle } = await handlerFor([hourly(), hourly({ name: "weekly" })], recordingAgent().agent);
    const res = await trigger(handle!, { name: "digets" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('no schedule named "digets" (this deployment has: digest, weekly)');
  });

  it("refuses a body that does not say which schedule, or names an occurrence that is not a date", async () => {
    const { handle } = await handlerFor([hourly()], recordingAgent().agent);
    expect((await trigger(handle!, {})).status).toBe(400);
    expect((await trigger(handle!, { name: "" })).status).toBe(400);
    expect((await trigger(handle!, "{not json")).status).toBe(400);
    expect((await trigger(handle!, { name: "digest", occurrence: "not-a-date" })).status).toBe(400);
    // The JSON gate every unverified route carries (channels/body.ts), here too.
    expect((await trigger(handle!, { name: "digest" }, { headers: {} })).status).toBe(415);
    expect((await handle!(new Request("http://h/trigger"))).status).toBe(405);
  });

  it("409s when the schedule has no further occurrences", async () => {
    const { handle } = await handlerFor([hourly({ cron: "0 0 9 * * * 2020" })], recordingAgent().agent);
    const res = await trigger(handle!, { name: "digest" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("has no further occurrences");
  });

  it("is not built at all when the definition declares no schedules", async () => {
    // A route that can only ever answer 404 is not a route, and its absence is what the startup report
    // and the deploy runbook describe.
    expect(createTriggerHandler({ agent: recordingAgent().agent, stateRoot: "/x", schedules: [] })).toBeUndefined();
  });

  it("translates a claim-state fault into a retryable 500 that leaks nothing about this container", async () => {
    // `fireScheduleOnce`'s only failure happens BEFORE a claim exists, so the occurrence is still
    // available and the clock's retry is the right answer — which is all the reply has to convey. The
    // cause is an fs error carrying absolute container paths, and the caller is unauthenticated, so it
    // goes to the log alone (the rule `refuseNonJsonBody` already follows by not echoing what arrived).
    const { agent } = recordingAgent();
    // A state root under a FILE: `mkdirSync` on the claims directory fails with ENOTDIR.
    const notADir = join(await stateRoot(), "file-not-a-dir");
    await (await import("node:fs/promises")).writeFile(notADir, "x");
    const handle = createTriggerHandler({ agent, stateRoot: notADir, schedules: [hourly()] });
    const logged: string[] = [];
    const spy = vi.spyOn(log, "error").mockImplementation((line: string) => void logged.push(line));
    try {
      const res = await trigger(handle!, { name: "digest" });
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).toContain("claim state unavailable, nothing was claimed — retry");
      expect(body).not.toContain(notADir); // no container path in a reply nobody authenticated
      // …and the operator still gets the whole thing, where it is safe to put it.
      expect(logged.join("\n")).toContain(notADir);
    } finally {
      spy.mockRestore();
    }
  });
});
