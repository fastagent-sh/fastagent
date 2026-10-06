/**
 * A schedule: a prompt the definition runs on a cron, written as `schedules/<name>.md` — the cron and its timezone in
 * the frontmatter, the prompt as the body. Plain data, like a skill or a prompt template, so an author, a client or the
 * agent itself writes one without touching TypeScript.
 *
 * WHAT IT IS NOT: a wake-up. The agent can schedule work for itself too (the `wake` tool, schedule/wakeups.ts). A
 * schedule is written in the DEFINITION (versioned, shipped with each release, named by its file) and a wake-up into the
 * STATE by a running agent (minted id, cancellable, aimed back at the conversation it came from).
 *
 * Nothing runs a schedule by name: the clock does. Work a caller wants to start itself is `POST /invoke`, and a prompt
 * it wants to reuse is a prompt template the caller names (`/daily-digest`).
 */

/** A schedule as loaded: its name is its file's name without `.md`. */
export interface Schedule {
  name: string;
  /** 5-field cron expression (`minute hour day-of-month month day-of-week`). */
  cron: string;
  /** IANA timezone for the cron (default "UTC"). */
  tz?: string;
  /** The turn's text. */
  prompt: string;
}

/**
 * The conversation a schedule's turns belong to: one per schedule, continued by every fire, so the agent sees what its
 * earlier runs did. The ONE spelling of it: the clock invokes through it and `fastagent schedules list` names it.
 */
export function scheduleSession(name: string): string {
  return `schedule:${name}`;
}
