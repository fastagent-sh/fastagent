import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import type { Agent, AgentEvent } from "../src/agent.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";
import { claimSlot, readFires } from "../src/schedule/state.ts";
import { createTriggerHandler } from "../src/schedule/trigger.ts";

// Counted, not faked: `previousRun` is ~40 synchronous croner evaluations on the one thread this
// process has, and how OFTEN this route runs it is the difference between ~30 req/s and ~30k.
const searches = vi.hoisted(() => ({ n: 0 }));
vi.mock("../src/schedule/cron.ts", async (real) => {
  const actual = await real<typeof import("../src/schedule/cron.ts")>();
  return {
    ...actual,
    previousRun: (...args: Parameters<typeof actual.previousRun>) => {
      searches.n += 1;
      return actual.previousRun(...args);
    },
  };
});

/**
 * `POST /trigger` — the external clock's half of a time trigger. The FIRE itself is `fireScheduleOnce`
 * and is covered in scheduler.test.ts; what belongs here is the wire: what the body may say, which
 * instant an omitted slot means, and what each outcome looks like to the clock that called.
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
  // PINNED, because the route now has a floor under the past (the current occurrence and the one
  // before it). A fixture naming a fixed instant while the clock runs free would pass today and start
  // reporting `too old` tomorrow.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it("fires the schedule the definition wrote down, for the slot the caller named", async () => {
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    const res = await trigger(handle!, { name: "digest", slot: "2026-07-07T10:00:00Z" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fired: true, slot: "2026-07-07T10:00:00.000Z" });
    // The PROMPT came from the definition, not the wire — that is the whole reason this route exists
    // beside `POST /invoke`, which would have carried one.
    expect(calls).toEqual([{ session: "schedule:digest", text: "summarise" }]);
    expect(readFires(root, "digest").map((f) => f.slot)).toEqual(["2026-07-07T10:00:00.000Z"]);
  });

  it("an omitted slot snaps to the occurrence the caller was woken for, not the one before it", async () => {
    // THE window a crontab actually lands in: cron wakes at the instant, the process starts, the
    // request arrives a few hundred milliseconds later. croner steps backwards by zeroing the
    // milliseconds and then subtracting a second, so without flooring, every `0 * * * *` trigger
    // fired by a crontab resolved to the PREVIOUS hour — permanently one occurrence behind, and
    // silently skipped outright once the resident clock had claimed that slot.
    {
      const { agent } = recordingAgent();
      const { handle } = await handlerFor([hourly()], agent);
      for (const offsetMs of [0, 1, 300, 999, 1000, 59_999]) {
        vi.setSystemTime(new Date(Date.parse("2026-07-07T10:00:00.000Z") + offsetMs));
        const body = (await (await trigger(handle!, { name: "digest" })).json()) as { slot: string };
        expect({ offsetMs, slot: body.slot }).toEqual({ offsetMs, slot: "2026-07-07T10:00:00.000Z" });
      }
    }
  });

  it("an omitted slot snaps to the occurrence this schedule most recently had", async () => {
    // A crontab line firing `curl` cannot compute the cron instant, and the slot is an IDENTITY:
    // sending `now` would mint a different claim name on every retry and run the turn twice.
    vi.setSystemTime(new Date("2026-07-07T10:17:42.391Z"));
    {
      const { agent } = recordingAgent();
      const { root, handle } = await handlerFor([hourly()], agent);
      expect(await (await trigger(handle!, { name: "digest" })).json()).toMatchObject({
        fired: true,
        slot: "2026-07-07T10:00:00.000Z",
      });
      // The retry a cron box makes after a lost response names the same slot, so it is a no-op.
      const retry = await (await trigger(handle!, { name: "digest" })).json();
      expect(retry).toMatchObject({ fired: false, slot: "2026-07-07T10:00:00.000Z" });
      expect(String((retry as { skippedReason: string }).skippedReason)).toContain("already claimed");
      expect(readFires(root, "digest")).toHaveLength(1);
    }
  });

  it("an OFF-GRID slot folds onto the occurrence it falls in, not into a claim of its own", async () => {
    // The starvation path the future-slot refusal does NOT close, reached from the past side. Every
    // off-grid instant is a new claim name, so each one runs a turn AND raises `newest` — and the real
    // occurrence that follows is then refused as stale (`wanted < newest`). It matters most under the
    // combination the docs recommend, `http.invoke: false` + `http.trigger: true`, whose whole point is
    // that an anonymous caller cannot start a turn.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    for (const off of ["2026-07-07T10:09:00Z", "2026-07-07T10:17:31Z", "2026-07-07T10:29:12Z"]) {
      expect((await trigger(handle!, { name: "digest", slot: off })).status).toBe(200);
    }
    // ONE turn, ONE claim: they are three deliveries of the 10:00 occurrence, whatever they were called.
    expect(calls).toHaveLength(1);
    expect(readFires(root, "digest").map((f) => f.slot)).toEqual(["2026-07-07T10:00:00.000Z"]);

    // …and the real instant is then an ordinary duplicate, not something the state root has moved past.
    const real = (await (await trigger(handle!, { name: "digest", slot: "2026-07-07T10:00:00Z" })).json()) as {
      slot: string;
      skippedReason?: string;
    };
    expect(real.slot).toBe("2026-07-07T10:00:00.000Z");
    expect(real.skippedReason).toContain("already claimed");
    expect(real.skippedReason).not.toContain("stale");
  });

  it("does not pay for a grid search per request — the floor is cached, and it judges before the snap", async () => {
    // The amplification this closes: one 404 lists every schedule name, after which repeating a slot
    // that is refused anyway used to run the search TWICE per request (the floor) plus once more for
    // the snap — ~18ms of blocking CPU, before any claim, with no turn to rate-limit against. That is
    // ~30 req/s to saturate the loop that also answers every channel webhook, `/control/*` and
    // `/health` — against the very posture (`http.invoke: false` + `http.trigger: true`) whose premise
    // is that an anonymous caller cannot make this process work.
    const { agent, calls } = recordingAgent();
    const { handle } = await handlerFor([hourly()], agent);
    const old = { name: "digest", slot: "2020-01-01T00:00:00Z" };

    searches.n = 0;
    expect(await (await trigger(handle!, old)).json()).toMatchObject({ fired: false });
    const warmUp = searches.n; // the floor: the current occurrence and the one before it
    expect(warmUp).toBeLessThanOrEqual(2);

    searches.n = 0;
    for (let i = 0; i < 50; i++) await trigger(handle!, old);
    expect(searches.n).toBe(0); // cached floor, and `asked` is judged before it would be snapped
    expect(calls).toEqual([]);

    // An accepted slot still snaps, and that is the one search a real delivery pays for.
    searches.n = 0;
    expect(await (await trigger(handle!, { name: "digest", slot: "2026-07-07T10:00:00Z" })).json()).toMatchObject({
      fired: true,
    });
    expect(searches.n).toBe(1);
  });

  it("an OLD occurrence is reported, not fired — history is not a queue of turns to buy", async () => {
    // `claimSlot` only judges `wanted < newest`, so walking history FORWARDS beats it every time: each
    // occurrence is newer than the last claim, so each one claims and runs. An hourly schedule has
    // ~100k enumerable occurrences, and nothing serialises requests naming different ones.
    //
    // The second injury is the fixed `schedule:<name>` session: a caller holding it busy makes the
    // resident clock's real occurrence fail with SESSION_BUSY_CODE after its claim is already taken,
    // which settles as `failed` and loses that occurrence silently.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    const old = ["2020-01-01T00:00:00Z", "2020-01-01T01:00:00Z", "2020-01-01T02:00:00Z"];
    for (const slot of old) {
      const body = (await (await trigger(handle!, { name: "digest", slot })).json()) as {
        fired: boolean;
        skippedReason?: string;
      };
      expect({ slot, fired: body.fired }).toEqual({ slot, fired: false });
      expect(body.skippedReason).toContain("too old");
    }
    expect(calls).toEqual([]);
    expect(readFires(root, "digest")).toEqual([]); // nothing claimed, so nothing is burned either
    // The window is the current occurrence and the one before it, which is what a late or retried
    // delivery names — EventBridge re-sends a fire it could not deliver, and that is not an attack.
    // Oldest first, because once the current occurrence is claimed the prior one is ordinarily stale:
    // the floor decides what may be ASKED for, `claimSlot` still decides what runs.
    expect(await (await trigger(handle!, { name: "digest", slot: "2026-07-07T09:00:00Z" })).json()).toMatchObject({
      fired: true,
    });
    expect(await (await trigger(handle!, { name: "digest", slot: "2026-07-07T10:00:00Z" })).json()).toMatchObject({
      fired: true,
    });
    // One occurrence further back is outside the window, and says so rather than being judged stale.
    const outside = (await (await trigger(handle!, { name: "digest", slot: "2026-07-07T08:00:00Z" })).json()) as {
      fired: boolean;
      skippedReason?: string;
    };
    expect(outside.fired).toBe(false);
    expect(outside.skippedReason).toContain("too old");
  });

  it("a slot the state root has moved past is reported, not fired", async () => {
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    const newer = new Date("2026-07-07T12:00:00Z");
    claimSlot(root, "digest", newer, newer);

    const res = await trigger(handle!, { name: "digest", slot: "2026-07-07T10:00:00Z" });
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

  it("refuses ANY slot ahead of the clock — a tolerance would still starve the resident clock", async () => {
    // `claimSlot`'s stale gate is `wanted < newest` with no ceiling, so a claim ahead of the wall clock
    // makes every real occurrence after it sort before the newest and be refused as stale — forever,
    // across restarts, for the resident clock too, recoverable only by deleting files in the container.
    //
    // A tolerance does not fix that, it prices it: with a window of T, a caller waits until the next
    // occurrence is within T and names it, starving the schedule for one cheap request per period.
    // This route is the only place a slot arrives from a caller we do not trust, so the window is zero.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    for (const ahead of ["2999-01-01T00:00:00Z", new Date(Date.now() + 30_000).toISOString()]) {
      const res = await trigger(handle!, { name: "digest", slot: ahead });
      expect({ ahead, status: res.status }).toEqual({ ahead, status: 400 });
      expect(await res.text()).toContain("ahead of this machine's clock");
    }
    expect(readFires(root, "digest")).toEqual([]); // nothing was written
    expect(calls).toEqual([]);

    // …and a real occurrence still fires afterwards, which is the property the refusal protects.
    expect(await (await trigger(handle!, { name: "digest", slot: "2026-07-07T10:00:00Z" })).json()).toMatchObject({
      fired: true,
    });
  });

  it("refuses a body that does not say which schedule, or says it with a bad slot", async () => {
    const { handle } = await handlerFor([hourly()], recordingAgent().agent);
    expect((await trigger(handle!, {})).status).toBe(400);
    expect((await trigger(handle!, { name: "" })).status).toBe(400);
    expect((await trigger(handle!, "{not json")).status).toBe(400);
    expect((await trigger(handle!, { name: "digest", slot: "not-a-date" })).status).toBe(400);
    // The JSON gate every unverified route carries (channels/body.ts), here too.
    expect((await trigger(handle!, { name: "digest" }, { headers: {} })).status).toBe(415);
    expect((await handle!(new Request("http://h/trigger"))).status).toBe(405);
  });

  it("409s when there is no occurrence to snap to", async () => {
    // A schedule whose first occurrence is still ahead: an omitted slot has nothing to name, and
    // inventing one would be a claim for an instant the schedule has never had (cron.ts previousRun).
    const { handle } = await handlerFor([hourly({ cron: "0 0 9 * * * 2099" })], recordingAgent().agent);
    const res = await trigger(handle!, { name: "digest" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("has no occurrence at or before");
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
      const res = await trigger(handle!, { name: "digest", slot: "2026-07-07T10:00:00Z" });
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
