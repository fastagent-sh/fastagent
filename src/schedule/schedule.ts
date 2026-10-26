/**
 * A schedule: a prompt the definition runs on a cron, written in TypeScript as `defineSchedule` in `src/schedules/`
 * (architecture.md §2), its name its file's. It is code, so it changes with a build and a deployment; the clock that
 * fires it is scheduler.ts, or on AgentCore the recurring EventBridge schedule the container sets (wake-alarm.ts).
 *
 * WHAT IT IS NOT: a wake-up. The agent can schedule work for itself too (the `wake` tool, schedule/wakeups.ts). A
 * schedule is written in the DEFINITION and a wake-up into the STATE by a running agent (minted id, cancellable, aimed
 * back at the conversation it came from).
 */
import { recurringCronError } from "./cron.ts";
import { toEventBridgeCron } from "./eventbridge-cron.ts";
import { MAX_PENDING_WAKEUPS } from "./wakeups.ts";

/** As many schedules as one conversation may have pending wake-ups: the same bound on what the agent can set going. */
export const MAX_SCHEDULES = MAX_PENDING_WAKEUPS;

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

/**
 * Why `config` is not a schedule this agent can run, or undefined: the one rule the build applies. Its cron passes the
 * guard a recurring wake-up passes, and is one AgentCore's clock (EventBridge) can express, so a schedule that runs
 * locally also runs there.
 */
export function scheduleConfigProblem(config: ScheduleConfig): string | undefined {
  if (typeof config.prompt !== "string" && typeof config.prompt !== "function")
    return "its prompt is a text or a function";
  if (config.prompt === "") return "its prompt is empty";
  if (typeof config.cron !== "string") return "its cron is a text";
  const invalid = recurringCronError(config.cron, config.tz);
  if (invalid !== undefined) return invalid;
  const translated = toEventBridgeCron(config.cron);
  return "error" in translated
    ? `AgentCore's clock (EventBridge) cannot express this cron: ${translated.error}`
    : undefined;
}
