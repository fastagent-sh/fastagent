import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { connectAgentCore, connectAgentCoreClock } from "@fastagent-sh/client/agentcore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  alarmNameOf,
  atExpression,
  createAlarmGroup,
  universalTargetArn,
} from "../../../packages/agentcore/src/alarms.ts";
import { agentCoreHandler } from "../../../packages/agentcore/src/runtime.ts";
import { DEPLOY_SCHEDULE_NAME, DEPLOY_SESSION_ID } from "../../../packages/agentcore/src/variables.ts";
import { watchInstanceAlarm } from "../../../packages/fastagent/src/harnesses/pi-durable/alarm.ts";
import { clockStore } from "../../../packages/fastagent/src/harnesses/pi-durable/clock.ts";
import { loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/pi-durable/open.ts";
import { fauxAgent } from "../../doubles/cli-run.ts";
import { type ServedPostgres, freshInstance, servedPostgres } from "../../doubles/postgres-double.ts";
import { RUNTIME, answered, installFakeAgentCore, invocation } from "./agentcore-fixture.ts";

let postgres: ServedPostgres;
beforeAll(async () => {
  postgres = await servedPostgres();
});
afterAll(() => postgres.close());

const agentCore = installFakeAgentCore();

/** EventBridge Scheduler in memory: one schedule group with `.deploy` seeded as `FastAgentResources` writes it. */
function fakeScheduler(group = "alarms-group", state: "ENABLED" | "DISABLED" = "DISABLED") {
  type StoredSchedule = {
    Name: string;
    GroupName: string;
    ScheduleExpression: string;
    ScheduleExpressionTimezone?: string;
    FlexibleTimeWindow: { Mode: "OFF" | "FLEXIBLE" };
    ActionAfterCompletion?: "NONE" | "DELETE";
    State: "ENABLED" | "DISABLED";
    Description?: string;
    Target: { Arn: string; RoleArn: string; Input: string };
  };
  const schedules = new Map<string, StoredSchedule>([
    [
      DEPLOY_SCHEDULE_NAME,
      {
        Name: DEPLOY_SCHEDULE_NAME,
        GroupName: group,
        ScheduleExpression: "rate(1 minute)",
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        State: state,
        Target: {
          Arn: universalTargetArn(),
          RoleArn: "arn:aws:iam::123456789012:role/alarm-role",
          Input: JSON.stringify({
            AgentRuntimeArn: RUNTIME,
            RuntimeSessionId: DEPLOY_SESSION_ID,
            ContentType: "application/json",
            Payload: JSON.stringify({ rearm: true }),
          }),
        },
      },
    ],
  ]);
  const calls: string[] = [];
  let nextError: Error | undefined;
  let afterWrite: ((name: string) => void | Promise<void>) | undefined;
  const notFound = (name: string) =>
    Object.assign(new Error(`Schedule ${name} not found`), { name: "ResourceNotFoundException" });
  return {
    schedules,
    calls,
    failNext(error: Error) {
      nextError = error;
    },
    onWritten(hook: ((name: string) => void | Promise<void>) | undefined) {
      afterWrite = hook;
    },
    client: {
      async send(command: unknown): Promise<unknown> {
        if (nextError !== undefined) {
          const err = nextError;
          nextError = undefined;
          throw err;
        }
        const { constructor: kind, input } = command as {
          constructor: { name: string };
          input: Partial<StoredSchedule> & { Name?: string };
        };
        const name = input.Name ?? "";
        if (kind.name === "GetScheduleCommand") {
          calls.push(`Get:${name}`);
          const found = schedules.get(name);
          if (found === undefined) throw notFound(name);
          return structuredClone(found);
        }
        if (kind.name === "CreateScheduleCommand") {
          calls.push(`Create:${name}`);
          if (schedules.has(name)) throw Object.assign(new Error("exists"), { name: "ConflictException" });
          schedules.set(name, structuredClone(input) as StoredSchedule);
          await afterWrite?.(name);
          return { ScheduleArn: `arn:aws:scheduler:ap-southeast-1:123456789012:schedule/${group}/${name}` };
        }
        if (kind.name === "UpdateScheduleCommand") {
          calls.push(`Update:${name}`);
          if (!schedules.has(name)) throw notFound(name);
          schedules.set(name, structuredClone(input) as StoredSchedule);
          await afterWrite?.(name);
          return { ScheduleArn: `arn:aws:scheduler:ap-southeast-1:123456789012:schedule/${group}/${name}` };
        }
        if (kind.name === "DeleteScheduleCommand") {
          calls.push(`Delete:${name}`);
          if (!schedules.delete(name)) throw notFound(name);
          return {};
        }
        throw new Error(`unexpected command: ${String(command)}`);
      },
    },
  };
}

describe("one EventBridge alarm per AgentCore session", () => {
  it("maps 256-char case-sensitive session ids into <=63-char schedule names and rounds `at` up to the second", () => {
    const shared = `user-${"a".repeat(95)}`;
    const first = alarmNameOf(`${shared}-Alpha-${"x".repeat(150)}`);
    const second = alarmNameOf(`${shared}-alpha-${"x".repeat(150)}`);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);

    const rounded = atExpression(new Date("2026-11-18T09:00:00.250Z"), new Date("2026-11-18T08:59:00.000Z"));
    expect(rounded.expression).toBe("at(2026-11-18T09:00:01)");
  });

  it("skips plain chat with no schedules, and wakes a cold scheduled microVM with HealthyBusy", async () => {
    const plainDir = await fauxAgent("fa-agentcore-plain-");
    const plainDef = await loadSourceDefinition(plainDir);
    const plainSched = fakeScheduler();
    const plainHandler = agentCoreHandler(plainDef, {
      database: { url: postgres.url },
      root: plainDir,
      secrets: process.env,
      alarms: createAlarmGroup({ group: "alarms-group", client: plainSched.client as never }),
    });
    const plainAws = agentCore(plainHandler);
    try {
      const agent = connectAgentCore({ runtimeArn: RUNTIME, sessionId: freshInstance() });
      const { id } = await agent.sessions.create();
      await agent.messages.send({ sessionId: id, content: "hello" }, { wait: 30 });
      expect(plainSched.calls).toEqual([]);
    } finally {
      await plainAws.close();
      await plainHandler.close();
    }

    const dir = await fauxAgent("fa-agentcore-alarm-", {
      "fastagent.config.ts": `import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
faux.setResponses(
  Array.from(
    { length: 10 },
    () => () => new Promise((r) => setTimeout(() => r(fauxAssistantMessage("cron-reply")), 300)),
  ),
);
export default { model: "gw/m1", providers: [faux.provider] };
`,
      "src/schedules/hourly.ts": `import { defineSchedule } from "@fastagent-sh/fastagent";
export default defineSchedule({ cron: "0 * * * *", tz: "UTC", prompt: "hourly-check" });
`,
    });
    const definition = await loadSourceDefinition(dir);
    const sched = fakeScheduler();
    const sessionId = freshInstance();
    const alarmName = alarmNameOf(sessionId);
    const since = new Date(Date.now() - 65 * 60_000).toISOString();
    const handler = agentCoreHandler(definition, {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      alarms: createAlarmGroup({ group: "alarms-group", client: sched.client as never }),
    });
    const aws = agentCore(handler);
    try {
      const ack = await handler.fetch(invocation(sessionId, { alarm: true, since }));
      expect([ack.status, await ack.json()]).toEqual([200, { ok: true }]);
      const pingDuring = (await (await handler.fetch(new Request("http://runtime/ping"))).json()) as { status: string };
      expect(pingDuring.status).toBe("HealthyBusy");

      await vi.waitFor(async () => {
        const pingAfter = (await (await handler.fetch(new Request("http://runtime/ping"))).json()) as {
          status: string;
        };
        expect(pingAfter.status).toBe("Healthy");
      });
      await vi.waitFor(() => expect(sched.schedules.get(alarmName)?.ScheduleExpression).toBeDefined());
      expect(sched.schedules.get(alarmName)?.ActionAfterCompletion).toBe("NONE");
    } finally {
      await aws.close();
      await handler.close();
    }
  });

  it("answers an alarm 503 only when the failure passes by itself (so Scheduler retries), and 200 when a person must fix it", async () => {
    const dir = await fauxAgent("fa-agentcore-alarm-err-");
    const definition = await loadSourceDefinition(dir);
    const transient = agentCoreHandler(definition, {
      database: { url: "postgres://postgres@127.0.0.1:1/postgres" },
      root: dir,
      secrets: process.env,
    });
    const broken = agentCoreHandler(definition, {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      values: async () => {
        throw new Error("the secret support cannot be read: ResourceNotFoundException");
      },
    });
    try {
      const retry = await transient.fetch(invocation(freshInstance(), { alarm: true }));
      expect(retry.status).toBe(503);
      const stop = await broken.fetch(invocation(freshInstance(), { alarm: true }));
      expect([stop.status, await stop.json()]).toEqual([
        200,
        { ok: false, error: "the secret support cannot be read: ResourceNotFoundException" },
      ]);
    } finally {
      await transient.close();
      await broken.close();
    }
  });

  it("re-arms existing and pre-configured instances after a deploy, keeps earlier active wakes, replaces past NONE schedules, and disables .deploy", async () => {
    const dir = await fauxAgent("fa-agentcore-rearm-", {
      "src/schedules/hourly.ts": `import { defineSchedule } from "@fastagent-sh/fastagent";
export default defineSchedule({ cron: "0 * * * *", tz: "UTC", prompt: "run hourly" });
`,
    });
    const definition = await loadSourceDefinition(dir);
    const dormant = freshInstance();
    const withEarlierWake = freshInstance();
    const withPastCompleted = freshInstance();
    const preconfigured = freshInstance();

    // Open `dormant`, `withEarlierWake` and `withPastCompleted` once so `durable_metadata` holds them for this agent.
    for (const sid of [dormant, withEarlierWake, withPastCompleted]) {
      const warm = agentCoreHandler(definition, {
        database: { url: postgres.url },
        root: dir,
        secrets: process.env,
      });
      await warm.fetch(invocation(sid, { request: { method: "GET", path: "/v1/agent", headers: {} } }));
      await warm.close();
    }

    const sched = fakeScheduler("alarms-group", "ENABLED");
    // Seed `withEarlierWake` at 10:20 (ahead of the 11:00 hourly slot), and `withPastCompleted` at 09:00 (in the past,
    // already completed under ActionAfterCompletion=NONE so it would never fire again on its own).
    const seed = (sid: string, expr: string) =>
      sched.schedules.set(alarmNameOf(sid), {
        Name: alarmNameOf(sid),
        GroupName: "alarms-group",
        ScheduleExpression: expr,
        FlexibleTimeWindow: { Mode: "OFF" },
        ActionAfterCompletion: "NONE",
        State: "ENABLED",
        Target: { Arn: universalTargetArn(), RoleArn: "arn:aws:iam::123456789012:role/alarm-role", Input: "{}" },
      });
    seed(withEarlierWake, "at(2026-11-18T10:20:00)");
    seed(withPastCompleted, "at(2026-11-18T09:00:00)");

    let clockNow = new Date("2026-11-18T10:05:00.000Z");
    const alarms = createAlarmGroup({
      group: "alarms-group",
      instances: [preconfigured],
      client: sched.client as never,
      now: () => clockNow,
    });
    const handler = agentCoreHandler(definition, {
      database: { url: postgres.url },
      root: dir,
      secrets: process.env,
      alarms,
    });
    try {
      // Only DEPLOY_SESSION_ID may run rearm.
      const wrongSession = await answered(await handler.fetch(invocation(dormant, { rearm: true })));
      expect([wrongSession.status, wrongSession.body.error.code]).toEqual([400, "invalid_request"]);

      const rearmed = await handler.fetch(invocation(DEPLOY_SESSION_ID, { rearm: true }));
      expect([rearmed.status, await rearmed.json()]).toEqual([200, { ok: true }]);

      expect(sched.schedules.get(alarmNameOf(dormant))?.ScheduleExpression).toBe("at(2026-11-18T11:00:00)");
      expect(sched.schedules.get(alarmNameOf(preconfigured))?.ScheduleExpression).toBe("at(2026-11-18T11:00:00)");
      expect(sched.schedules.get(alarmNameOf(withPastCompleted))?.ScheduleExpression).toBe("at(2026-11-18T11:00:00)");
      // The earlier active 10:20 alarm stays untouched.
      expect(sched.schedules.get(alarmNameOf(withEarlierWake))?.ScheduleExpression).toBe("at(2026-11-18T10:20:00)");
      // `.deploy` disabled itself once rearm succeeded.
      expect(sched.schedules.get(DEPLOY_SCHEDULE_NAME)?.State).toBe("DISABLED");

      // At 11:00:04, delivering the payload `.deploy` armed onto the never-before-opened `preconfigured` session
      // catches up the 11:00:00 cron slot (via `since`) and moves its alarm to 12:00:00.
      const payload = JSON.parse(
        (JSON.parse(sched.schedules.get(alarmNameOf(preconfigured))!.Target.Input) as { Payload: string }).Payload,
      ) as { alarm: boolean; since: string };
      vi.useFakeTimers({ toFake: ["Date", "performance"] });
      clockNow = new Date("2026-11-18T11:00:04.000Z");
      vi.setSystemTime(clockNow);
      const coldSession = agentCoreHandler(definition, {
        database: { url: postgres.url },
        root: dir,
        secrets: process.env,
        alarms,
      });
      // Simulate the process failing right after EventBridge records `at(12:00:00)`: `start({ since })` must have
      // ALREADY claimed the `11:00:00` slot before `setAlarm` ran, so moving the alarm forward never skips 11:00.
      let cutOffOnce = true;
      sched.onWritten((writtenName) => {
        if (cutOffOnce && writtenName === alarmNameOf(preconfigured)) {
          cutOffOnce = false;
          throw new Error("cut off after EventBridge stored 12:00:00");
        }
      });
      await coldSession.fetch(invocation(preconfigured, payload));
      sched.onWritten(undefined);
      await coldSession.close();
      expect(sched.schedules.get(alarmNameOf(preconfigured))?.ScheduleExpression).toBe("at(2026-11-18T12:00:00)");

      const checkSession = agentCoreHandler(definition, {
        database: { url: postgres.url },
        root: dir,
        secrets: process.env,
        alarms,
      });
      const aws = agentCore(checkSession);
      try {
        const preClock = connectAgentCoreClock({ runtimeArn: RUNTIME, sessionId: preconfigured });
        await vi.waitFor(async () => {
          const states = await preClock.schedules.list();
          expect(states[0]?.last?.slot).toBe("2026-11-18T11:00:00.000Z");
        });
      } finally {
        await aws.close();
        await checkSession.close();
      }
    } finally {
      vi.useRealTimers();
      await handler.close();
    }
  });

  it("drains a newer clock commit after a failed alarm write, and stops writing as soon as the harness begins closing", async () => {
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const clock = clockStore(harness, BACKGROUND_CONTEXT);
    let desired: Date | undefined = new Date("2026-11-18T10:00:00.000Z");
    const seen: Array<string | undefined> = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let attempts = 0;
    const alarm = watchInstanceAlarm({
      harness,
      nextClockDue: async () => desired,
      setAlarm: async (at) => {
        attempts += 1;
        seen.push(at?.toISOString());
        if (attempts === 1) {
          await firstBlocked;
          throw new Error("ThrottlingException");
        }
      },
    });
    try {
      const first = alarm.sync();
      await vi.waitFor(() => expect(attempts).toBe(1));
      // While the first `setAlarm` is in flight, a clock commit clears `desired` (setting `dirty = true`), then the
      // first `setAlarm` fails: the queued `dirty` pass must still run and disarm (with `forceClear` preserved too).
      desired = undefined;
      void alarm.sync({ forceClear: true });
      await clock.armed(() => ({ next: {}, result: undefined }));
      releaseFirst();
      await expect(first).rejects.toThrow("ThrottlingException");
      await vi.waitFor(() => expect(seen).toEqual(["2026-11-18T10:00:00.000Z", undefined]));
    } finally {
      alarm.stop();
      await harness.close(BACKGROUND_CONTEXT);
    }

    // Second half: `subscribeClose` fences an in-flight read synchronously when `harness.close()` begins.
    const closingHarness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readingStarted = false;
    const fencedWrites: Array<Date | undefined> = [];
    const fencedAlarm = watchInstanceAlarm({
      harness: closingHarness,
      nextClockDue: async () => {
        readingStarted = true;
        await readBlocked;
        return new Date("2026-11-18T18:00:00.000Z");
      },
      setAlarm: async (at) => {
        fencedWrites.push(at);
      },
    });
    const inFlightSync = fencedAlarm.sync();
    await vi.waitFor(() => expect(readingStarted).toBe(true));
    const closePromise = closingHarness.close(BACKGROUND_CONTEXT);
    releaseRead();
    await inFlightSync;
    await closePromise;
    expect(fencedWrites).toEqual([]);
  });
});
