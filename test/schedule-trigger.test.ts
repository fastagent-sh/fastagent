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
 * occurrence a delivery is for, and what each outcome looks like to the clock that called.
 *
 * The body names a schedule and NOTHING ELSE. A caller-named instant was tried and removed — the
 * cases that used to live here (a future slot poisoning `claimSlot`'s gate, an off-grid one minting a
 * claim no occurrence matches, an old one replaying history, and the grid searches all three needed)
 * are not fixed defects but absent ones: there is no longer a number on the wire to be wrong.
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

  it("fires the schedule the definition wrote down, for the occurrence its own clock is in", async () => {
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    const res = await trigger(handle!, { name: "digest" });

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

  it("every delivery inside one occurrence is that occurrence — jitter is not a second claim", async () => {
    // Deliveries do not arrive at the instant: cron wakes, a process starts, a Lambda forwards, a
    // retry lands. The slot is an IDENTITY (`claimSlot` keys on it), so if each arrival named its own
    // moment, each would be a fresh claim that ran its own turn AND raised `newest` — after which the
    // resident clock's real occurrence is refused as stale. Snapping to the grid is what makes the
    // spread of arrival times collapse onto the one occurrence they all belong to.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    for (const arrival of ["2026-07-07T10:00:09Z", "2026-07-07T10:17:31Z", "2026-07-07T10:29:12Z"]) {
      vi.setSystemTime(new Date(arrival));
      expect((await trigger(handle!, { name: "digest" })).status).toBe(200);
    }
    // ONE turn, ONE claim: three deliveries of the 10:00 occurrence, whenever they happened to land.
    expect(calls).toHaveLength(1);
    expect(readFires(root, "digest").map((f) => f.slot)).toEqual(["2026-07-07T10:00:00.000Z"]);

    // …and they read as ordinary duplicates, not as something the state root has moved past.
    const again = (await (await trigger(handle!, { name: "digest" })).json()) as {
      slot: string;
      skippedReason?: string;
    };
    expect(again.slot).toBe("2026-07-07T10:00:00.000Z");
    expect(again.skippedReason).toContain("already claimed");
    expect(again.skippedReason).not.toContain("stale");

    // The NEXT occurrence still fires — the claim gate was never poisoned by any of it.
    vi.setSystemTime(new Date("2026-07-07T11:00:04Z"));
    expect(await (await trigger(handle!, { name: "digest" })).json()).toMatchObject({
      fired: true,
      slot: "2026-07-07T11:00:00.000Z",
    });
    expect(calls).toHaveLength(2);
  });

  it("does not pay for a grid search per request — the occurrence is cached until the grid moves", async () => {
    // The route is anonymous, and `previousRun` is ~40 synchronous croner evaluations (~6ms measured)
    // on the one thread that also answers every channel webhook, `/control/*` and `/health`. Repeating
    // the request is free for the caller, so it has to be free here too.
    const { agent, calls } = recordingAgent();
    const { handle } = await handlerFor([hourly()], agent);

    searches.n = 0;
    expect((await trigger(handle!, { name: "digest" })).status).toBe(200);
    expect(searches.n).toBe(1); // the cold read of this schedule's current occurrence

    searches.n = 0;
    for (let i = 0; i < 50; i++) expect((await trigger(handle!, { name: "digest" })).status).toBe(200);
    expect(searches.n).toBe(0);
    expect(calls).toHaveLength(1); // one turn; `claimSlot` made the other 50 duplicates

    // It recomputes once when the grid moves past it, and not again.
    searches.n = 0;
    vi.setSystemTime(new Date("2026-07-07T11:30:00Z"));
    for (let i = 0; i < 10; i++) await trigger(handle!, { name: "digest" });
    expect(searches.n).toBe(1);
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

  it("a slot the state root has moved past is reported, not fired", async () => {
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

  it("refuses a body that does not say which schedule", async () => {
    const { handle } = await handlerFor([hourly()], recordingAgent().agent);
    expect((await trigger(handle!, {})).status).toBe(400);
    expect((await trigger(handle!, { name: "" })).status).toBe(400);
    expect((await trigger(handle!, "{not json")).status).toBe(400);
    // The JSON gate every unverified route carries (channels/body.ts), here too.
    expect((await trigger(handle!, { name: "digest" }, { headers: {} })).status).toBe(415);
    expect((await handle!(new Request("http://h/trigger"))).status).toBe(405);
  });

  it("409s when the schedule has not come due yet", async () => {
    // Armed, but the grid has not reached its first occurrence. There is nothing to claim, and
    // inventing an instant would claim one the schedule has never had (cron.ts previousRun).
    const { handle } = await handlerFor([hourly({ cron: "0 0 9 * * * 2099" })], recordingAgent().agent);
    const res = await trigger(handle!, { name: "digest" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("has not come due yet");
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
