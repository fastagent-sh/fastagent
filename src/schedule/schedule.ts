/** Schedule authoring: `defineSchedule` (the authoring surface). */

/**
 * A time-triggered invocation: at each `cron` instant (in `tz`, default UTC) the scheduler invokes the agent with
 * `prompt`.
 */
export interface Schedule {
  /** 5-field cron expression (`minute hour day-of-month month day-of-week`). */
  cron: string;
  /** IANA timezone for the cron (default "UTC"). */
  tz?: string;
  /** The turn's text = the job's instruction. */
  prompt: string;
}

/** Identity function for typing + IDE completion (like `defineTool`/`defineConfig`). */
export function defineSchedule(schedule: Schedule): Schedule {
  return schedule;
}

/** A loaded schedule: its authored fields plus the name derived from its filename (authoritative). */
export interface LoadedSchedule extends Schedule {
  name: string;
}
