/** Leveled logging. */
const ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
const isLevel = (s) => Object.hasOwn(ORDER, s);
const format = (level, msg) => `${level.toUpperCase().padEnd(5)} ${msg}`;
/** `FASTAGENT_LOG_LEVEL` resolved PER EMIT, not at import. */
let posture = "info";
let warnedFor;
function effectiveLevel() {
    const raw = process.env.FASTAGENT_LOG_LEVEL;
    if (!raw)
        return posture;
    const value = raw.toLowerCase();
    if (isLevel(value))
        return value;
    if (warnedFor !== raw) {
        warnedFor = raw;
        console.error(format("warn", `[fastagent] unknown FASTAGENT_LOG_LEVEL "${raw}"; using the posture default`));
    }
    return posture;
}
/** Set the posture default. */
export function setLogLevel(level) {
    posture = level;
}
const emit = (level) => (msg) => {
    if (ORDER[level] >= ORDER[effectiveLevel()])
        console.error(format(level, msg));
};
export const log = { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
