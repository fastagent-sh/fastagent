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

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const isLevel = (s: string): s is LogLevel => s in ORDER;
const format = (level: LogLevel, msg: string): string => `${level.toUpperCase().padEnd(5)} ${msg}`;

/** A standalone logger over an explicit sink — used in tests to assert level gating without the singleton. */
export function createLogger(opts: { level: LogLevel; sink?: (line: string) => void }): Logger {
  const sink = opts.sink ?? ((line) => console.error(line));
  const make =
    (level: LogLevel) =>
    (msg: string): void => {
      if (ORDER[level] >= ORDER[opts.level]) sink(format(level, msg));
    };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}

/**
 * `FASTAGENT_LOG_LEVEL` parsed to three states: a valid value locks the level (overrides posture); a
 * present-but-invalid value warns and is treated as absent, so a typo (meant to make logs louder) can
 * never silently pin the level to info nor kill the posture default; absent returns undefined. The
 * warning is raw — the singleton below is not built yet — but reuses `format` for the same shape.
 */
function parseEnvOverride(): LogLevel | undefined {
  const raw = process.env.FASTAGENT_LOG_LEVEL;
  if (raw === undefined) return undefined;
  const value = raw.toLowerCase();
  if (isLevel(value)) return value;
  console.error(format("warn", `[fastagent] unknown FASTAGENT_LOG_LEVEL "${raw}"; using the posture default`));
  return undefined;
}

const override = parseEnvOverride();
let currentLevel: LogLevel = override ?? "info";

/** Set the posture default. A valid `FASTAGENT_LOG_LEVEL` override, if present, wins and is not changed. */
export function setLogLevel(level: LogLevel): void {
  if (override === undefined) currentLevel = level;
}

const emit =
  (level: LogLevel) =>
  (msg: string): void => {
    if (ORDER[level] >= ORDER[currentLevel]) console.error(format(level, msg));
  };

/** The process logger. Runtime code imports this and calls `log.info(...)` etc. */
export const log: Logger = { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
