/**
 * Composable clock runner outside the core Agent harness: runs schedules and wake-ups against any `Agent`, exposes the
 * operator `ClockApi` (`schedules`, `wakeups`), and cleans up wake-ups when a session is deleted.
 */
import * as Effect from "effect/Effect";
import type { Agent, ClockApi } from "@fastagent-sh/client/agent-api";
import type { ClockStore } from "./clock.ts";
import { clockOperations } from "./operations.ts";
import type { Schedule } from "./schedule.ts";
import { type Scheduler, createScheduler } from "./scheduler.ts";
import { removeSessionWakeups } from "./wakeups.ts";

export interface ClockRunner {
  readonly api: ClockApi;
  start(options?: { since?: Date }): Promise<void>;
  stop(): void;
  tick(options?: { since?: Date }): Promise<void>;
  nextDue(at?: Date): Promise<Date | undefined>;
  onSessionDelete(sessionId: string): Promise<void>;
}

export function createClockRunner(options: {
  agent: Pick<Agent, "sessions" | "messages">;
  store: ClockStore;
  schedules: readonly Schedule[];
  now?: () => Date;
}): ClockRunner {
  const { agent, store, schedules, now } = options;
  const api = clockOperations(
    { sessions: { get: agent.sessions.get, create: agent.sessions.create }, messages: agent.messages },
    { store, schedules },
  );
  let scheduler: Scheduler | undefined;
  return {
    api,
    async start(startOptions) {
      const created = Effect.runSync(
        createScheduler({ agent, clock: store, schedules, ...(now === undefined ? {} : { now }) }),
      );
      await created.start(startOptions).catch((error: unknown) => {
        created.stop();
        throw error;
      });
      scheduler = created;
    },
    stop() {
      scheduler?.stop();
      scheduler = undefined;
    },
    async tick(tickOptions) {
      await scheduler?.tick(tickOptions);
    },
    nextDue(at) {
      return scheduler?.nextDue(at) ?? Promise.resolve(undefined);
    },
    async onSessionDelete(sessionId) {
      await removeSessionWakeups(store, sessionId);
    },
  };
}
