/**
 * The agent's clock as the Agent API offers it: fire a schedule now and read schedule state. Runs in the process that
 * owns the instance beside its resident scheduler so a fire takes its slot's claim and never runs an occurrence twice.
 */
import * as Effect from "effect/Effect";
import {
  type Agent,
  type ClockApi,
  type Message,
  type ScheduleState,
  agentError,
} from "@fastagent-sh/client/agent-api";
import { beginWork } from "../busy.ts";
import { log } from "../log.ts";
import type { ClockStore } from "./clock.ts";
import { nextRun } from "./cron.ts";
import type { Schedule } from "./schedule.ts";
import { type ScheduledAgent, fireScheduleNow } from "./scheduler.ts";
import { latestFire } from "./state.ts";

/** Where the clock keeps its state, and what it fires: an instance's. Without one, the agent has no clock. */
export interface ClockState {
  store: ClockStore;
  schedules: readonly Schedule[];
}

/** Each of `schedules` as the Agent API says it: when it fires next, from `now`, and its last occurrence. */
export async function scheduleStates(
  store: ClockStore,
  schedules: readonly Schedule[],
  now: Date = new Date(),
): Promise<ScheduleState[]> {
  return Promise.all(
    schedules.map(async (s) => {
      const last = await latestFire(store, s.name);
      const next = nextRun(s.cron, s.tz, now);
      return {
        name: s.name,
        cron: s.cron,
        ...(s.tz === undefined ? {} : { tz: s.tz }),
        ...(next === undefined ? {} : { next: next.toISOString() }),
        ...(last === undefined ? {} : { last }),
      } satisfies ScheduleState as ScheduleState;
    }),
  );
}

export function clockOperations(
  agent: ScheduledAgent & Pick<Agent, "messages">,
  clock: ClockState | undefined,
): ClockApi {
  return {
    schedules: {
      async run(name, options = {}) {
        const schedule = clock?.schedules.find((s) => s.name === name);
        if (clock === undefined || schedule === undefined) throw agentError("not_found", `no schedule "${name}"`);
        let accepted!: (message: Message) => void;
        const sent = new Promise<Message>((resolve) => {
          accepted = resolve;
        });
        const done = beginWork();
        const fire = Effect.runPromise(fireScheduleNow({ agent, clock: clock.store, schedule, accepted })).finally(
          done,
        );
        const first = await Promise.race([
          sent.then((message) => ({ message })),
          fire.then((outcome) => ({ outcome })),
        ]);
        if ("message" in first) {
          // The fire goes on to its end in this process; what it failed at is the fire's log line and claim.
          fire.catch((error: unknown) => log.error(`[schedule] ${name}: ${String(error)}`));
          const { message } = first;
          return {
            status: "sent",
            message:
              options.wait === undefined
                ? message
                : await agent.messages.get({ sessionId: message.sessionId, messageId: message.id }, options),
          };
        }
        const { outcome } = first;
        if (!outcome.fired && outcome.skippedReason !== undefined)
          return { status: "skipped", reason: outcome.skippedReason };
        throw agentError(
          "internal",
          `the schedule "${name}" did not send its message: ${outcome.failed ?? "no reason"}`,
        );
      },
      list: async () => (clock === undefined ? [] : scheduleStates(clock.store, clock.schedules)),
    },
  };
}
