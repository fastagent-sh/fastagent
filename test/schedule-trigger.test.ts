import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentEvent } from "../src/agent.ts";
import { log } from "../src/log.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";
import { createTriggerHandler } from "../src/schedule/trigger.ts";

/**
 * `POST /trigger` — an API, not a time trigger. What belongs here is the wire: what the body may say,
 * what an `idempotencyKey` buys, and what each outcome looks like to the caller.
 *
 * NO OCCURRENCE, no claim, no fire history, no freshness window. Those exist where fastagent owns the
 * clock — the resident loop (scheduler.test.ts) and AgentCore's authenticated envelope
 * (agentcore-service.test.ts) — because only a clock we produced can say which occurrence a run is
 * for. The cases that used to live here are absent rather than fixed: there is no instant on the wire
 * to be wrong.
 */

const hourly = (over: Partial<LoadedSchedule> = {}): LoadedSchedule =>
  ({ name: "digest", cron: "0 * * * *", tz: "UTC", prompt: "summarise", ...over }) as LoadedSchedule;

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
  return { root, handle: createTriggerHandler({ agent, stateRoot: root, schedules }) };
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
  it("runs the work the definition declared, named by the caller and nothing else", async () => {
    const { agent, calls } = recordingAgent();
    const { handle } = await handlerFor([hourly()], agent);
    const res = await trigger(handle!, { name: "digest" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "digest", ran: true });
    // The PROMPT came from the definition, not the wire — the whole reason this exists beside
    // `POST /invoke`, whose caller brings its own text and therefore its own behaviour.
    expect(calls).toEqual([{ session: "schedule:digest", text: "summarise" }]);
  });

  it("without a key, every call is a call — this route is an API, not a clock", async () => {
    // No occurrence, so nothing here can tell one call from another. A caller that wants a retry to
    // be safe says so with a key; a caller that just wants the work run gets the work run.
    const { agent, calls } = recordingAgent();
    const { handle } = await handlerFor([hourly()], agent);
    for (let i = 0; i < 3; i++) expect((await trigger(handle!, { name: "digest" })).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("an idempotencyKey makes a RETRY safe, and a different key a different call", async () => {
    const { agent, calls } = recordingAgent();
    const { handle } = await handlerFor([hourly()], agent);

    expect(await (await trigger(handle!, { name: "digest", idempotencyKey: "fire-1" })).json()).toMatchObject({
      ran: true,
    });
    for (let i = 0; i < 4; i++) {
      const again = (await (await trigger(handle!, { name: "digest", idempotencyKey: "fire-1" })).json()) as {
        ran: boolean;
        reason?: string;
      };
      expect(again.ran).toBe(false);
      expect(again.reason).toContain("already ran");
    }
    expect(calls).toHaveLength(1);

    expect(await (await trigger(handle!, { name: "digest", idempotencyKey: "fire-2" })).json()).toMatchObject({
      ran: true,
    });
    expect(calls).toHaveLength(2);
  });

  it("the key is OPAQUE — an instant, a uuid and a word are all just bytes", async () => {
    // The property that makes this design smaller than the one it replaced: nothing parses the key, so
    // there is no future to refuse, no grid to be off, and no history to replay.
    const { agent, calls } = recordingAgent();
    const { handle } = await handlerFor([hourly()], agent);
    for (const key of ["2999-01-01T00:00:00Z", "550e8400-e29b-41d4-a716-446655440000", "tuesday", "0"]) {
      expect(await (await trigger(handle!, { name: "digest", idempotencyKey: key })).json()).toMatchObject({
        ran: true,
      });
      expect(await (await trigger(handle!, { name: "digest", idempotencyKey: key })).json()).toMatchObject({
        ran: false,
      });
    }
    expect(calls).toHaveLength(4); // one per distinct key, whatever it looked like
  });

  it("concurrent retries of one key run the turn once", async () => {
    const { agent, calls } = recordingAgent();
    const { handle } = await handlerFor([hourly()], agent);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => trigger(handle!, { name: "digest", idempotencyKey: "same" })),
    );
    const bodies = (await Promise.all(results.map((r) => r.json()))) as { ran: boolean }[];
    expect(bodies.filter((b) => b.ran)).toHaveLength(1);
    expect(calls).toHaveLength(1);

    // WHAT THIS DOES NOT PROVE, stated because a mutation showed it: swapping the `O_EXCL` create for
    // a readdir-then-write keeps this green. `claimIdempotencyKey` is fully synchronous, so one event
    // loop cannot interleave two of them — the race it guards is between PROCESSES over one state
    // root (a restart overlap, two containers on a shared volume), which nothing in this suite can
    // stage. The guard stays for the reason `claimSlot` has the same one, and that reason is written
    // at the guard rather than implied here.
  });

  it("refuses a body that names no work, and a key that is not a bounded string", async () => {
    const { handle } = await handlerFor([hourly()], recordingAgent().agent);
    expect((await trigger(handle!, {})).status).toBe(400);
    expect((await trigger(handle!, { name: "" })).status).toBe(400);
    expect((await trigger(handle!, "{not json")).status).toBe(400);
    expect((await trigger(handle!, { name: "digest", idempotencyKey: "" })).status).toBe(400);
    expect((await trigger(handle!, { name: "digest", idempotencyKey: 7 })).status).toBe(400);
    // CAPPED: without a length, the key is a way to write 4 KiB of caller bytes into this container's
    // state on every call.
    expect((await trigger(handle!, { name: "digest", idempotencyKey: "k".repeat(201) })).status).toBe(400);
    expect((await trigger(handle!, { name: "digest", idempotencyKey: "k".repeat(200) })).status).toBe(200);
    // The JSON gate every unverified route carries (channels/body.ts), here too.
    expect((await trigger(handle!, { name: "digest" }, { headers: {} })).status).toBe(415);
    expect((await handle!(new Request("http://h/trigger"))).status).toBe(405);
  });

  it("names the work it does have when the caller names work it does not, clipped", async () => {
    // Drift: a caller outliving the thing it calls. Listing the names is what lets an operator tell a
    // typo from a stale job without shelling in — and the ECHO is the one thing clipped, because
    // quoting 4 KiB of an unauthenticated caller's body back is what `refuseNonJsonBody` forbids.
    const { handle } = await handlerFor([hourly(), hourly({ name: "weekly" })], recordingAgent().agent);
    const res = await trigger(handle!, { name: "digets" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('no declared work named "digets" (this deployment has: digest, weekly)');

    const long = await trigger(handle!, { name: "x".repeat(4000) });
    const said = await long.text();
    expect(said).toContain("x".repeat(64));
    expect(said).not.toContain("x".repeat(65));
  });

  it("a key that cannot be RECORDED runs nothing — that is what the key was sent to prevent", async () => {
    // Running anyway would turn the caller's next retry into a second turn. The cause is an fs error
    // carrying absolute container paths and the caller is unauthenticated, so it goes to the log alone.
    const { agent, calls } = recordingAgent();
    const notADir = join(await stateRoot(), "file-not-a-dir");
    await writeFile(notADir, "x");
    const handle = createTriggerHandler({ agent, stateRoot: notADir, schedules: [hourly()] });
    const logged: string[] = [];
    const spy = vi.spyOn(log, "error").mockImplementation((line: string) => void logged.push(line));
    try {
      const res = await trigger(handle!, { name: "digest", idempotencyKey: "k" });
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).toContain("could not record the idempotency key, nothing ran — retry");
      expect(body).not.toContain(notADir); // no container path in a reply nobody authenticated
      expect(calls).toEqual([]); // and nothing ran
      expect(logged.join("\n")).toContain(notADir); // the operator still gets all of it
    } finally {
      spy.mockRestore();
    }
  });

  it("is not built at all when the definition declares nothing runnable", async () => {
    // A route that can only ever answer 404 is not a route, and its absence is what the startup report
    // and the deploy runbook describe.
    expect(createTriggerHandler({ agent: recordingAgent().agent, stateRoot: "/x", schedules: [] })).toBeUndefined();
  });

  it("reports a turn that failed, with a 200 — the CALL succeeded", async () => {
    // The distinction an API caller needs: the request was accepted and the work ran, and the work is
    // what failed. Retrying the call would re-run a turn whose side effects may already have landed.
    const { agent } = recordingAgent([{ type: "failed", retryable: false, details: "upstream 500" }]);
    const { handle } = await handlerFor([hourly()], agent);
    const res = await trigger(handle!, { name: "digest" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ran: true, failed: "upstream 500" });
  });
});
