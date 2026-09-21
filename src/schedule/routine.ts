/**
 * Routine authoring: `defineRoutine`.
 *
 * A ROUTINE IS THE UNIT OF WORK, and the only named one in the system: a prompt the definition owns, addressed by
 * name. `cron` is a FIELD of it, not a second concept — with one, a clock fires it; without one, it is reached by
 * name alone (`POST /run`). That is why this is not called a "schedule" any more: the file used to be named for the
 * time it carried, and a file carrying no time made the name a lie.
 *
 * WHAT IT IS NOT: a wake-up. The agent can schedule work for itself too (`selfSchedule`, schedule/wakeups.ts), and
 * conceptually that is the same idea — work to be done later. Every operational difference between them follows
 * from ONE root: a routine is written in the DEFINITION (versioned, reviewed, shipped with the image, addressable
 * by name) and a wake-up is written into the STATE by a running agent (minted id, cancellable, aimed back at the
 * conversation it came from, erased by the next release if it were a definition file). Code and data.
 *
 * A `prompt` may be a function of the file's declared `secrets` — the only reason such a file ever read the
 * environment (src/declared-secrets.ts).
 */
import { secretValues } from "../declared-secrets.ts";

/**
 * WHICH conversation a routine's turns belong to: all of them, so a routine shares one continuing conversation —
 * and without depending on engine session storage. The ONE spelling of it: the clock invokes through it,
 * `fastagent routine run` reproduces a run with it, `POST /run` reports it as where to look, and
 * `routine history` prints the command that opens it.
 */
export function routineSession(name: string): string {
  return `routine:${name}`;
}

/** A named unit of work the definition owns. With a `cron`, a clock fires it; without one, only its name reaches it. */
export interface Routine {
  /**
   * 5-field cron expression (`minute hour day-of-month month day-of-week`), or absent.
   *
   * ABSENT IS A REAL CHOICE, not an omission: the routine is then reachable only by name — `POST /run`, the CLI, a
   * platform scheduler that calls the route. A time is one way to ask for work, not what the work is.
   */
  cron?: string;
  /** IANA timezone for the cron (default "UTC"). Meaningless without `cron`. */
  tz?: string;
  /** The turn's text = the routine's instruction. */
  prompt: string;
  /** Env vars this routine declared — carried by `deploy`, asserted before the clock starts. */
  secrets?: readonly string[];
}

/** What an author writes. `prompt` may be built FROM the declared secrets, which is the only reason a
 *  routine file ever read the environment (a channel id, a target inbox). */
export interface DefineRoutineOptions<S extends readonly string[]> {
  cron?: string;
  tz?: string;
  prompt: string | ((secrets: Record<S[number], string>) => string);
  /**
   * Env vars this routine needs (`["SLACK_DIGEST_CHANNEL"]`), typed into the `prompt` builder.
   * `deploy` carries them and the clock refuses to start while one is unset, naming this file
   * (see src/declared-secrets.ts) — the guarantees a bare `process.env` read cannot have.
   */
  secrets?: S;
}

/** Type + completion for a routine file, and the ONE place a prompt builder is resolved (at load:
 *  what the loader stores is always a string, so every consumer sees one shape). */
export function defineRoutine<const S extends readonly string[] = readonly []>(
  routine: DefineRoutineOptions<S>,
): Routine {
  const { prompt, ...rest } = routine;
  return { ...rest, prompt: typeof prompt === "function" ? prompt(secretValues(routine.secrets)) : prompt };
}

/** A loaded routine: its authored fields plus the name derived from its filename (authoritative). */
export interface LoadedRoutine extends Routine {
  name: string;
}
