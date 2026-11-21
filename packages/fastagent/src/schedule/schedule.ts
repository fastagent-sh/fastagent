/**
 * A schedule: a prompt the definition runs on a cron, written in TypeScript as `defineSchedule` in `src/schedules/`,
 * its name its file's.
 */
import { recurringCronError } from "./cron.ts";

export const MAX_SCHEDULES = 20;

/** What an author writes. */
export interface ScheduleConfig {
  /** Five fields, minute first; checked when the definition is built. */
  cron: string;
  /** IANA timezone. Default: UTC. */
  tz?: string;
  /** What the agent is told when it fires: a text, or one made for the instant it fires for. */
  prompt: string | ((fire: { at: Date }) => string | Promise<string>);
}

/** A schedule as built: its name is its file's name. */
export interface Schedule extends ScheduleConfig {
  name: string;
}

/** Why `config` is not a schedule this agent can run, or undefined. */
export function scheduleConfigProblem(config: ScheduleConfig): string | undefined {
  if (typeof config.prompt !== "string" && typeof config.prompt !== "function")
    return "its prompt is a text or a function";
  if (config.prompt === "") return "its prompt is empty";
  if (typeof config.cron !== "string") return "its cron is a text";
  return recurringCronError(config.cron, config.tz);
}
