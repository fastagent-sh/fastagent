/** Schedule authoring: `defineSchedule`. A `prompt` may be a function of the file's declared
 *  `secrets` — the only reason such a file ever read the environment (src/declared-secrets.ts). */
import { secretValues } from "../declared-secrets.ts";

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
  /** Env vars this schedule declared — carried by `deploy`, asserted before the scheduler starts. */
  secrets?: readonly string[];
}

/** What an author writes. `prompt` may be built FROM the declared secrets, which is the only reason a
 *  schedule file ever read the environment (a channel id, a target inbox). */
export interface DefineScheduleOptions<S extends readonly string[]> {
  cron: string;
  tz?: string;
  prompt: string | ((secrets: Record<S[number], string>) => string);
  /**
   * Env vars this schedule needs (`["SLACK_DIGEST_CHANNEL"]`), typed into the `prompt` builder.
   * `deploy` carries them and the scheduler refuses to start while one is unset, naming this file
   * (see src/declared-secrets.ts) — the guarantees a bare `process.env` read cannot have.
   */
  secrets?: S;
}

/** Type + completion for a schedule file, and the ONE place a prompt builder is resolved (at load:
 *  what the scheduler stores is always a string, so every consumer sees one shape). */
export function defineSchedule<const S extends readonly string[] = readonly []>(
  schedule: DefineScheduleOptions<S>,
): Schedule {
  const { prompt, ...rest } = schedule;
  return { ...rest, prompt: typeof prompt === "function" ? prompt(secretValues(schedule.secrets)) : prompt };
}

/** A loaded schedule: its authored fields plus the name derived from its filename (authoritative). */
export interface LoadedSchedule extends Schedule {
  name: string;
}
