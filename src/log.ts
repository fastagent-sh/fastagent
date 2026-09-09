/** Leveled logging. */

type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const isLevel = (s: string): s is LogLevel => Object.hasOwn(ORDER, s);
const format = (level: LogLevel, msg: string): string => `${level.toUpperCase().padEnd(5)} ${msg}`;

/** `FASTAGENT_LOG_LEVEL` resolved PER EMIT, not at import. */
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

/** Set the posture default. */
export function setLogLevel(level: LogLevel): void {
  posture = level;
}

const emit =
  (level: LogLevel) =>
  (msg: string): void => {
    if (ORDER[level] >= ORDER[effectiveLevel()]) console.error(format(level, msg));
  };

export const log = { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
