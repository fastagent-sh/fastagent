/** `fastagent schedule history|list|cancel`. */
import { resolve } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { resolveStateRoot } from "../../paths.ts";
import { reportModuleLoadFailures } from "../../loader.ts";
import { resolveSessionsDir } from "../../engines/pi/config.ts";
import { readJournal } from "../../engines/pi/session-journal.ts";
import { piSessionRecordStore } from "../../engines/pi/session-store.ts";
import { nextRun } from "../../schedule/cron.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { scheduleSession } from "../../schedule/scheduler.ts";
import { type Fire, isSafeScheduleName, readFires } from "../../schedule/state.ts";
import { listWakeups, removeWakeup } from "../../schedule/wakeups.ts";
import type { SessionEntry } from "../../session.ts";
import { failStartup, placementOrExit } from "../fail.ts";

/** What the turn a fire produced ended up saying, or why it ended badly. */
export interface FireTurn {
  /** The last assistant message of that turn (empty for a turn that only failed). */
  text: string;
  /** pi's `errorMessage` for a turn that ended in an error — the reason no claim can carry. */
  error?: string;
}

/**
 * Join fired slots to the turns they produced, keyed by slot.
 *
 * There is no shared id to join on: a claim records `firedAt`, and the turn records its own entry timestamps, so the
 * match is by TIME and is bounded on BOTH sides — a fire owns the first user entry at or after its own instant and
 * before the NEXT fire's — AND before its own fire ended. That second bound is what makes the newest fire safe:
 * other writers append to the same session (a wake-up, `fastagent fire` by hand, an operator over the control
 * plane), and with only a next-fire bound the last claim would own whatever anyone typed hours later.
 *
 * A claim states its own end only once it has SETTLED (`firedAt + ms`), and a turn cannot start after its own fire
 * finished. An unsettled claim states nothing — `interrupted` is written without a duration, and a still-running fire
 * has not reported one — so it owns no turn rather than a later writer's. It has nothing to show either way: a fire
 * that never reached an answer has no reply to print.
 *
 * The reply is the LAST assistant entry before the next user entry, because a turn that called tools appends several.
 */
export function turnsForFires(fires: Fire[], entries: SessionEntry[]): Map<string, FireTurn> {
  const turns: { at: number; reply?: FireTurn }[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      turns.push({ at: entry.timestamp });
      continue;
    }
    const current = turns.at(-1);
    if (!current || entry.kind !== "assistant") continue;
    const data = entry.data as { text?: unknown; errorMessage?: unknown };
    current.reply = {
      text: typeof data.text === "string" ? data.text : "",
      ...(typeof data.errorMessage === "string" ? { error: data.errorMessage } : {}),
    };
  }
  const ordered = [...fires].sort((a, b) => a.firedAt.localeCompare(b.firedAt));
  const matched = new Map<string, FireTurn>();
  let next = 0;
  for (const [index, fire] of ordered.entries()) {
    const from = Date.parse(fire.firedAt);
    // A claim whose stamp fell back to an unusable slot name cannot anchor a window.
    if (Number.isNaN(from)) continue;
    const nextFire = Date.parse(ordered[index + 1]?.firedAt ?? "");
    const ended = fire.ms === undefined ? from : from + fire.ms;
    // Turns are scanned once across all fires: both lists are in time order, so a turn already passed cannot belong
    // to a later fire.
    while (next < turns.length && (turns[next] as { at: number }).at < from) next++;
    const turn = turns[next];
    if (!turn) continue;
    if (turn.at > ended) continue; // started after this fire finished — somebody else's turn
    if (!Number.isNaN(nextFire) && turn.at >= nextFire) continue; // the next fire's
    if (turn.reply) matched.set(fire.slot, turn.reply);
    next++;
  }
  return matched;
}

const PREVIEW_CHARS = 100;

/** One folded line of what a turn said — code-point safe, so a cut never lands inside an emoji. */
function preview(turn: FireTurn | undefined): string {
  const text = turn?.error ?? turn?.text ?? "";
  // Cut to UTF-16 units FIRST (the same rule as `firstUserText` in session-store.ts): a megabyte reply would
  // otherwise become a million-element array just to take the first 100 code points, once per printed row. Twice the
  // budget is enough for any surrogate pairing, and folding whitespace after the cut cannot grow it.
  const folded = text
    .slice(0, PREVIEW_CHARS * 2)
    .replace(/\s+/g, " ")
    .trim();
  const cut = Array.from(folded);
  return cut.length > PREVIEW_CHARS ? `${cut.slice(0, PREVIEW_CHARS).join("")}\u2026` : folded;
}

/**
 * `fastagent schedule history <name> [dir]`: print this schedule's fired slots — when each fired, how it ended, how
 * long it took.
 *
 * The fired slots ARE the claims (`schedule/claims/<name>/`), bounded by construction and carrying no turn text.
 * What each run SAID is read back from the session it ran in (`schedule:<name>`), where it is stored once — directly
 * off disk, so this works with no serve running, which is the normal state when someone asks what last night did.
 */
export async function runScheduleHistory(name: string, dirArg: string, json: boolean): Promise<void> {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target); // FASTAGENT_STATE_DIR may live in .env — read the SAME state root the scheduler wrote
  const stateRoot = resolveStateRoot(target);
  // A name that cannot be a schedule is a MISTYPED ARGUMENT, and it must not look like an empty history: exit 1 the
  // way every other user-input refusal does, so `--json` printing nothing is never read as "the command succeeded".
  if (!isSafeScheduleName(name)) {
    failStartup(new Error(`"${name}" cannot be a schedule name (no path separators, "." or "..")`));
  }
  // `readFires` throws a raw fs error on unreadable state, because its other caller is the serving boot, which must
  // fail rather than arm a schedule it cannot read. This caller is a read-only CLI command: the same fact is an
  // operator's to fix, so it exits the way every other refusal in this file does instead of printing a Node stack.
  let fires: Fire[];
  try {
    fires = readFires(stateRoot, name);
  } catch (e) {
    failStartup(new Error(`the fired-slot claims for "${name}" are unreadable (state: ${stateRoot}): ${String(e)}`));
  }
  // A session that was never created (nothing ever fired, or an older state root) is not an error: the fires are
  // still the answer to "did it run", only without what it said.
  const sessionsDir = resolveSessionsDir(target);
  const record = await piSessionRecordStore({ dir: sessionsDir, cwd: target }).openIfExists(scheduleSession(name));
  // SAY it, rather than printing an empty text column: "this schedule has no session here" and "the turn produced no
  // text" read identically otherwise, and one of the two ways to get here is a sessions dir that is not the one the
  // serve wrote (FASTAGENT_SESSIONS_DIR set for only one of them).
  if (!record && fires.length > 0) {
    console.error(`no session "${scheduleSession(name)}" under ${sessionsDir} — fired slots below, without their text`);
  }
  const turns = record ? turnsForFires(fires, readJournal(record).entries) : new Map<string, FireTurn>();
  if (json) {
    console.log(
      JSON.stringify(
        fires.map((f) => ({ ...f, ...(turns.get(f.slot) ? { turn: turns.get(f.slot) } : {}) })),
        null,
        2,
      ),
    );
    return;
  }
  if (fires.length === 0) {
    // No special case for "wake": it is an ordinary schedule name now (`discover.ts` stopped reserving it).
    console.error(`no recorded fires for "${name}" (state: ${stateRoot})`);
    return;
  }
  // The question is "did LAST NIGHT's run fail?", so text mode tails the most recent fires; --json above is the
  // whole retained window.
  const TAIL = 20;
  const shown = fires.slice(-TAIL);
  for (const f of shown) {
    // An unreported fire has no duration to print, and `0ms` would be a value a fast turn really produces — the
    // column stays empty rather than claiming the turn took no time.
    const took = f.ms === undefined ? "" : `${f.ms}ms`;
    console.log(
      `${f.firedAt}  ${(f.outcome ?? "unreported").padEnd(11)} ${took.padStart(8)}  ${preview(turns.get(f.slot))}`,
    );
  }
  if (fires.length > shown.length) {
    console.error(`(the last ${shown.length} of ${fires.length} fires — --json for all)`);
  }
}

/** `fastagent schedule list [dir]`: everything that will fire. */
export async function runScheduleList(dirArg: string, json: boolean): Promise<void> {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target);
  const { schedules, failures } = await loadSchedules(target).catch(failStartup);
  reportModuleLoadFailures(failures);
  const wakeups = listWakeups(resolveStateRoot(target));
  if (json) {
    console.log(
      JSON.stringify(
        {
          schedules: schedules.map((s) => ({ ...s, next: nextRun(s.cron, s.tz, new Date())?.toISOString() })),
          wakeups,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (schedules.length === 0 && wakeups.length === 0) {
    console.error(`nothing scheduled — no schedules/ files, no pending wake-ups (state: ${resolveStateRoot(target)})`);
    return;
  }
  for (const s of schedules) {
    const next = nextRun(s.cron, s.tz, new Date())?.toISOString() ?? "(never)";
    console.log(`schedule  ${s.name.padEnd(20)} ${next}  cron ${s.cron}${s.tz ? ` ${s.tz}` : ""}`);
  }
  for (const w of wakeups) {
    const kind = w.cron ? `cron ${w.cron}${w.tz ? ` ${w.tz}` : ""}` : "one-shot";
    console.log(`wake      ${w.id}  ${w.fireAt}  ${kind}  session=${w.session}  ${w.prompt.slice(0, 60)}`);
  }
}

/**
 * `fastagent schedule cancel <id> [dir]`: remove a pending wake-up — the operator's kill switch (the agent's own is
 * the `unwake` tool).
 */
export function runScheduleCancel(id: string, dirArg: string): void {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  enterAgentEnv(target);
  if (removeWakeup(resolveStateRoot(target), id)) {
    // ponytail: the store's load→save is lock-free — a serving scheduler's claim-advance can race this write (window
    // = ms around each fire).
    console.error(
      `[fastagent] cancelled wake-up ${id} — if a server is running, verify with \`fastagent schedule list\``,
    );
  } else {
    failStartup(
      new Error(
        `no pending wake-up ${id} (state: ${resolveStateRoot(target)}) — \`fastagent schedule list\` shows ids`,
      ),
    );
  }
}
