/**
 * Schedule authoring: `defineSchedule` (the authoring surface). Drop a file in `schedules/`,
 * default-export `defineSchedule({...})`, and it is discovered, named from the filename, and run by the
 * scheduler — a time-trigger (the N axis, clock form) that fires the agent on a cron.
 *
 *   // schedules/daily-digest.ts        → schedule "daily-digest"
 *   export default defineSchedule({
 *     cron: "0 9 * * *",
 *     tz: "America/New_York",
 *     prompt: "Generate today's digest and send it to the team Telegram.",
 *   });
 *
 * A schedule carries NO session field: a session id is runtime conversational context (the K side —
 * host-provided per invoke, core.md §10.1 / §7), not a build-time (M) value. The scheduler derives a
 * stable per-schedule session from the name at runtime (like
 * the telegram channel derives one from chat.id), so a schedule's turns share one continuing
 * conversation, persisted by the core session store. Output is the AGENT's tools' job — the scheduler
 * only fires and logs, it does not deliver.
 */

/** A time-triggered invocation: at each `cron` instant (in `tz`, default UTC) the scheduler invokes the
 *  agent with `prompt`. */
export interface Schedule {
  /** 5-field cron expression (`minute hour day-of-month month day-of-week`). */
  cron: string;
  /** IANA timezone for the cron (default "UTC"). Wall-clock schedules (daily 9am) need it. */
  tz?: string;
  /** The turn's text = the job's instruction. The agent's tools decide where any output goes. */
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
