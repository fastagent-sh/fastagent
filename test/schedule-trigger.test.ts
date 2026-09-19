import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentEvent } from "../src/agent.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";
import { claimSlot, readFires } from "../src/schedule/state.ts";
import { createTriggerHandler } from "../src/schedule/trigger.ts";

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

describe("schedule/trigger: POST /trigger", () => {
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
    vi.useFakeTimers();
    try {
      const { agent } = recordingAgent();
      const { handle } = await handlerFor([hourly()], agent);
      for (const offsetMs of [0, 1, 300, 999, 1000, 59_999]) {
        vi.setSystemTime(new Date(Date.parse("2026-07-07T10:00:00.000Z") + offsetMs));
        const body = (await (await trigger(handle!, { name: "digest" })).json()) as { slot: string };
        expect({ offsetMs, slot: body.slot }).toEqual({ offsetMs, slot: "2026-07-07T10:00:00.000Z" });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("an omitted slot snaps to the occurrence this schedule most recently had", async () => {
    // A crontab line firing `curl` cannot compute the cron instant, and the slot is an IDENTITY:
    // sending `now` would mint a different claim name on every retry and run the turn twice.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T10:17:42.391Z"));
    try {
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
    } finally {
      vi.useRealTimers();
    }
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

  it("refuses a slot in the future, which would otherwise poison the schedule permanently", async () => {
    // `claimSlot`'s stale gate is `wanted < newest` with no ceiling, so one claim dated 2999 makes every
    // real occurrence after it sort before the newest and be refused as stale — forever, across
    // restarts, for the resident clock too. Recovery means deleting files inside the container. This
    // route is the only place a slot arrives from a caller we do not trust.
    const { agent, calls } = recordingAgent();
    const { root, handle } = await handlerFor([hourly()], agent);
    const far = await trigger(handle!, { name: "digest", slot: "2999-01-01T00:00:00Z" });
    expect(far.status).toBe(400);
    expect(await far.text()).toContain("is in the future");
    expect(readFires(root, "digest")).toEqual([]); // nothing was written
    expect(calls).toEqual([]);

    // …and a real occurrence still fires afterwards, which is the property the bound protects.
    expect(await (await trigger(handle!, { name: "digest", slot: "2026-07-07T10:00:00Z" })).json()).toMatchObject({
      fired: true,
    });

    // Clock skew between two machines is not an attack: a slot a few seconds ahead is accepted.
    const skewed = new Date(Date.now() + 5_000).toISOString();
    expect((await trigger(handle!, { name: "digest", slot: skewed })).status).toBe(200);
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

  it("is not built at all when the definition declares no schedules", async () => {
    // A route that can only ever answer 404 is not a route, and its absence is what the startup report
    // and the deploy runbook describe.
    expect(createTriggerHandler({ agent: recordingAgent().agent, stateRoot: "/x", schedules: [] })).toBeUndefined();
  });

  it("translates a claim-state fault into the caller's own log, and leaves the slot unburned", async () => {
    // `fireScheduleOnce`'s only failure happens BEFORE a claim exists, so the occurrence is still
    // available and the clock's retry is the right answer — which it can only decide if the message
    // reaches its logs rather than the server's alone.
    const { agent } = recordingAgent();
    // A state root under a FILE: `mkdirSync` on the claims directory fails with ENOTDIR.
    const notADir = join(await stateRoot(), "file-not-a-dir");
    await (await import("node:fs/promises")).writeFile(notADir, "x");
    const handle = createTriggerHandler({ agent, stateRoot: notADir, schedules: [hourly()] });
    const res = await trigger(handle!, { name: "digest", slot: "2026-07-07T10:00:00Z" });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('firing schedule "digest" for slot 2026-07-07T10:00:00.000Z failed');
  });
});
