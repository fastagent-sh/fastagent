/**
 * Composable clock runner outside the core Agent harness: runs declarative cron schedules against any `Agent` and
 * exposes the operator `ClockApi`.
 */
import * as Effect from "effect/Effect";
import type { Agent, ClockApi } from "@fastagent-sh/client/agent-api";
import type { ClockStore } from "./clock.ts";
import { clockOperations } from "./operations.ts";
import type { Schedule } from "./schedule.ts";
import { type Scheduler, createScheduler } from "./scheduler.ts";

export interface ClockRunner {
  readonly api: ClockApi;
  start(options?: { since?: Date }): Promise<void>;
  stop(): void;
  tick(options?: { since?: Date }): Promise<void>;
  nextDue(at?: Date): Promise<Date | undefined>;
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
  let runSeq = 0;
  return {
    api,
    async start(startOptions) {
      const seq = ++runSeq;
      scheduler?.stop();
      scheduler = undefined;
      const created = Effect.runSync(
        createScheduler({ agent, clock: store, schedules, ...(now === undefined ? {} : { now }) }),
      );
      scheduler = created;
      try {
        await created.start(startOptions);
      } catch (error) {
        created.stop();
        if (scheduler === created) scheduler = undefined;
        throw error;
      }
      if (seq !== runSeq) {
        created.stop();
        if (scheduler === created) scheduler = undefined;
      }
    },
    stop() {
      runSeq += 1;
      scheduler?.stop();
      scheduler = undefined;
    },
    async tick(tickOptions) {
      await scheduler?.tick(tickOptions);
    },
    nextDue(at) {
      return scheduler?.nextDue(at) ?? Promise.resolve(undefined);
    },
  };
}
