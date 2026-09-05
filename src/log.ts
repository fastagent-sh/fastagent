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

/** An embedded logger over an explicit sink — used in tests to assert level gating without the singleton. */
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
 * `FASTAGENT_LOG_LEVEL` resolved PER EMIT, not at import: this module is imported transitively by every
 * command module, so an import-time read runs before any command reaches `loadDotEnv` and could never
 * see the agent's `.secrets/.env` — a key that file could not carry at all.
 *
 * Three states: a valid value wins over the posture; a present-but-invalid one warns (once per distinct
 * value) and is treated as absent, so a typo (meant to make logs louder) can never silently pin the
 * level nor kill the posture default; absent leaves the posture. The warning is raw `console.error`
 * because it is the logger reporting on its own gate, but reuses `format` for the same shape.
 */
let posture: LogLevel = "info";
let warnedFor: string | undefined;

function effectiveLevel(): LogLevel {
  const raw = process.env.FASTAGENT_LOG_LEVEL;
  if (raw === undefined) return posture;
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
import type { ModuleLoadFailure } from "./loader.ts";

export const log: Logger = { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };

/** A module the loader skipped, said once, the same way for tools, channels and schedules. */
export function reportModuleLoadFailures(failures: readonly ModuleLoadFailure[]): void {
  for (const f of failures) log.warn(`[fastagent] ${f.label} failed to load, skipping it — ${f.message}`);
}
