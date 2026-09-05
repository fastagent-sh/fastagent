/**
 * Leveled logging. Runtime logs (lifecycle, warnings, errors, the debug turn trace) flow through ONE
 * process-level logger, gated by a single level. It is a module singleton — not an injected dependency —
 * because most runtime logs originate inside author-constructed channels (`channels/*.ts` call the
 * channel factory themselves) and deep engine code, which the CLI cannot thread a logger into. The CLI
 * sets the level by posture (dev → debug, start → info); `FASTAGENT_LOG_LEVEL` overrides it.
 *
 * This is NOT the CLI's user-facing output (help text, command results): that is the program talking to
 * its operator and stays on plain `console`. Everything here is operational logging to stderr.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const isLevel = (s: string): s is LogLevel => Object.hasOwn(ORDER, s);
const format = (level: LogLevel, msg: string): string => `${level.toUpperCase().padEnd(5)} ${msg}`;

/**
 * `FASTAGENT_LOG_LEVEL` resolved PER EMIT, not at import: this module is imported transitively by every
 * command module, so an import-time read runs before any command reaches `loadDotEnv` and could never
 * see the agent's `.secrets/.env` — a key that file could not carry at all.
 *
 * Three states: a valid value wins over the posture; an invalid value warns when it differs from the
 * last warned value and is treated as absent, so a typo (meant to make logs louder) can never silently pin the
 * level nor kill the posture default; absent leaves the posture. Empty is absent, matching
 * `resolveOverridePath` — `KEY=` is how a `.env` parks a key it does not want set, not a typo to warn
 * about. The warning is raw `console.error` because it is the logger reporting on its own gate, but
 * reuses `format` for the same shape.
 */
let posture: LogLevel = "info";
let warnedFor: string | undefined;

function effectiveLevel(): LogLevel {
  const raw = process.env.FASTAGENT_LOG_LEVEL;
  if (!raw) return posture;
  const value = raw.toLowerCase();
  if (isLevel(value)) return value;
  if (warnedFor !== raw) {
    warnedFor = raw;
    console.error(format("warn", `[fastagent] unknown FASTAGENT_LOG_LEVEL "${raw}"; using the posture default`));
  }
  return posture;
}

/** Set the posture default. A valid `FASTAGENT_LOG_LEVEL` wins over it, whenever a line is emitted. */
export function setLogLevel(level: LogLevel): void {
  posture = level;
}

const emit =
  (level: LogLevel) =>
  (msg: string): void => {
    if (ORDER[level] >= ORDER[effectiveLevel()]) console.error(format(level, msg));
  };

/** The process logger. Runtime code imports this and calls `log.info(...)` etc. */
export const log = { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
