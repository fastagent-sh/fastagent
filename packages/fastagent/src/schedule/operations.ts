/**
 * The agent's clock as the Agent API offers it: fire a schedule now, cancel a wake-up. It runs in the process that owns
 * the instance, beside its resident scheduler: a fire takes its slot's claim as every clock does, so the two never run
 * one occurrence twice, and the wake-up store is written by one process.
 */
import * as Effect from "effect/Effect";
import { type Agent, type Message, type Wakeup, agentError } from "@fastagent-sh/client/agent-api";
import { beginWork } from "../busy.ts";
import { log } from "../log.ts";
import type { Schedule } from "./schedule.ts";
import { type ScheduledAgent, fireScheduleNow } from "./scheduler.ts";
import { removeAnyWakeup } from "./wakeups.ts";

/** Where the clock keeps its state, and what it fires: an instance's. Without one, the agent has no clock. */
export interface ClockState {
  stateRoot: string;
  schedules: readonly Schedule[];
}

export function clockOperations(
  agent: ScheduledAgent & Pick<Agent, "messages">,
  clock: ClockState | undefined,
): Pick<Agent, "schedules" | "wakeups"> {
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
        const fire = Effect.runPromise(
          fireScheduleNow({ agent, stateRoot: clock.stateRoot, schedule, accepted }),
        ).finally(done);
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
    },
    wakeups: {
      async cancel(id) {
        const removed = clock === undefined ? undefined : removeAnyWakeup(clock.stateRoot, id);
        if (removed === undefined) throw agentError("not_found", `no pending wake-up ${id}`);
        const { session, prompt, fireAt, cron, tz } = removed;
        return {
          id: removed.id,
          sessionId: session,
          fireAt,
          prompt,
          ...(cron === undefined ? {} : { cron }),
          ...(tz === undefined ? {} : { tz }),
        } satisfies Wakeup as Wakeup;
      },
    },
  };
}
