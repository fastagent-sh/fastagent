/**
 * Wake ALARMS for the AgentCore deployment: the piece that makes the agent's self-scheduled
 * wake-ups (`wake`) reliable on a host with NO resident process. The mechanism, end to end:
 *
 *   wake written → wakeups store save → the SINK here → POST the full pending set to the
 *   forwarder's reserved path → the forwarder (which has the AWS SDK + an IAM role) mirrors each
 *   pending wake-up into a ONE-SHOT EventBridge schedule (`at(fireAt)`, self-deleting) → at the
 *   instant, EventBridge pokes the forwarder → InvokeAgentRuntime wakes the container → the boot /
 *   30s wake pump finds the due entry and fires it (the existing overdue catch-up — no new fire
 *   path). A RECURRING wake re-arms itself: its claim advances `fireAt` in the store, which is a
 *   save, which re-runs this sink, which re-upserts its alarm for the next occurrence.
 *
 * The container itself never calls AWS (no SDK dependency, no SigV4, no credential chain): it only
 * POSTs to its own deployment's public forwarder URL, authenticated by a shared secret
 * (`FASTAGENT_WAKE_SECRET`, a CloudFormation NoEcho parameter both sides receive). The URL is not
 * baked anywhere — the forwarder INJECTS it into every envelope it forwards (it resolves its own
 * Function URL at cold start), and the adapter persists it here; every wake write happens inside a
 * turn, and every ingress turn arrived through an envelope, so the URL is always known by then.
 *
 * Reconciliation is DECLARATIVE (the sink is told only THAT the store changed and reads the full
 * pending set back per attempt, so no retry ever carries a stale view) and deletion is lazy: a
 * cancelled wake-up's alarm still fires its poke, finds nothing due, and self-deletes — a harmless
 * wasted wake-up of the box, traded for never needing list/delete choreography.
 */
import { readFileSync } from "node:fs";
import { RESERVED_PATHS, type WakeAlarm, type WakeAlarmRequest } from "../channels/agentcore-protocol.ts";
import { beginWork } from "../channels/busy.ts";
import { log } from "../log.ts";
import { scheduleFile, writeScheduleFile } from "./state.ts";
import { type Wakeup, listWakeups } from "./wakeups.ts";

const URL_FILE = "wake-alarm-url";

/**
 * Persist the forwarder URL the adapter saw in an envelope (write-if-changed — envelopes arrive on
 * every turn, the file should not churn). Durable under <stateRoot>/schedule/ so a freshly booted
 * container whose FIRST action is a wake fire (recurring advance → save → sink) knows the URL
 * before any envelope of its own has arrived.
 */
export function rememberWakeAlarmUrl(stateRoot: string, url: string): void {
  if (readWakeAlarmUrl(stateRoot) === url) return;
  writeScheduleFile(scheduleFile(stateRoot, URL_FILE), { url });
}

/** The persisted forwarder URL, or undefined before the first envelope ever seen. */
export function readWakeAlarmUrl(stateRoot: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(scheduleFile(stateRoot, URL_FILE), "utf8")) as { url?: unknown };
    return typeof v.url === "string" ? v.url : undefined;
  } catch {
    return undefined; // absent/corrupt — the next envelope rewrites it
  }
}

/** How many times one alarm sync is retried before giving up (each store mutation and every boot
 *  restart the cycle, and the pending store is the durable desired state — so "give up" means "until
 *  the next mirror", never "lost"). */
export const MAX_SYNC_ATTEMPTS = 5;
const RETRY_BASE_MS = 2_000;
const SYNC_TIMEOUT_MS = 10_000;
/** Alarms due within this margin are NOT mirrored: the box is awake handling them right now (that is
 *  how their fireAt got written/claimed), and a past `at()` would only fail at the Scheduler API —
 *  filtering them client-side keeps every forwarder failure a REAL one worth retrying. */
const DUE_MARGIN_MS = 5_000;

/** Pending wake-ups → the desired alarm set, minus already-due entries (see {@link DUE_MARGIN_MS}). */
export function toAlarms(pending: Wakeup[], now: Date): WakeAlarm[] {
  return pending
    .filter((w) => Date.parse(w.fireAt) > now.getTime() + DUE_MARGIN_MS)
    .map((w) => ({ id: w.id, at: w.fireAt }));
}

/**
 * Build the wakeups sink for an AgentCore deployment (registered via `setWakeupsSink` by `start`
 * when `FASTAGENT_AGENTCORE=1` + `FASTAGENT_WAKE_SECRET` are present). Fire-and-forget by contract:
 * failures are logged, never thrown — a broken alarm degrades to the pre-alarm behavior (the wake
 * still fires on the next time the box happens to be awake), it must never break the store write.
 *
 * A single-flight RECONCILER, not a per-mutation delivery: a notification only marks the desired
 * state dirty, and the loop re-derives it from the store before every attempt. So a mutation during
 * a retry needs no ordering rule — there is one desired state, never two snapshots to rank — and the
 * {@link DUE_MARGIN_MS} filter is re-applied with a fresh clock, which a captured payload could not
 * do: entries that became due mid-retry would keep being POSTed with a past `at()`, a rejection no
 * number of retries could clear.
 *
 * Assumes ONE sink per process over ONE state root (what `start` builds): the loop keeps the root of
 * the call that started it, and its dirty flag is shared, so a second root would fold into the first
 * one's pass.
 */
export function createWakeAlarmSink(options: {
  secret: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => Date;
  /** Injectable retry pause (tests); defaults to exponential-ish backoff off RETRY_BASE_MS. */
  delay?: (ms: number) => Promise<void>;
}): (stateRoot: string) => void {
  const { secret, fetchImpl = fetch, now = () => new Date() } = options;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let running = false;
  let dirty = false;

  /** One POST of the CURRENT desired set. Returns false to retry, true when there is nothing left
   *  to do (converged, or nothing this loop can act on). */
  async function attemptOnce(stateRoot: string, attempt: number): Promise<boolean> {
    const alarms = toAlarms(listWakeups(stateRoot), now());
    // Nothing future to mirror: converged. Deletion is lazy by design — alarms already mirrored for
    // cancelled wake-ups fire, find nothing, self-delete — so an empty set is never POSTed.
    if (alarms.length === 0) return true;
    const url = readWakeAlarmUrl(stateRoot);
    if (!url) {
      // Before the first envelope, or an unreadable state mount (readWakeAlarmUrl folds both into
      // undefined). The wake itself is stored; the next store mutation or boot re-mirrors it.
      log.warn("[schedule] wake alarm skipped — forwarder URL unavailable (not seen yet, or unreadable)");
      return true;
    }
    const body: WakeAlarmRequest = { secret, alarms };
    try {
      const res = await fetchImpl(`${url.replace(/\/$/, "")}${RESERVED_PATHS.wakeAlarm}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      });
      if (res.ok) return true;
      log.warn(`[schedule] wake alarm sync attempt ${attempt}/${MAX_SYNC_ATTEMPTS} failed: HTTP ${res.status}`);
    } catch (e) {
      log.warn(`[schedule] wake alarm sync attempt ${attempt}/${MAX_SYNC_ATTEMPTS} failed: ${String(e)}`);
    }
    return false;
  }

  async function reconcile(stateRoot: string): Promise<void> {
    // Counted as in-flight work: the retry loop is exactly the window where the box must not be
    // reclaimed — idle away mid-retry and a pending wake has no alarm until the next boot.
    const workDone = beginWork();
    // Consecutive failures ACROSS passes, not within one. A mid-retry mutation restarts the attempt
    // sequence (the backoff and the log's `n/N` are about the new desired set), but it must not renew
    // the budget: a store mutating faster than the backoff would keep the loop alive forever, and the
    // one loud line saying the forwarder is down — the per-attempt warns are filterable — would never
    // be reached. This counter is the thing that survives to reach it.
    let failures = 0;
    try {
      while (dirty && failures < MAX_SYNC_ATTEMPTS) {
        dirty = false;
        for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
          if (await attemptOnce(stateRoot, attempt)) {
            failures = 0;
            break;
          }
          failures++;
          if (attempt === MAX_SYNC_ATTEMPTS || failures >= MAX_SYNC_ATTEMPTS) break;
          await delay(RETRY_BASE_MS * attempt);
          // A mutation landed mid-retry: the desired state moved, so this budget is spent on a set
          // that no longer exists. Restart the attempt count against the new one.
          if (dirty) break;
        }
      }
      if (failures >= MAX_SYNC_ATTEMPTS) {
        log.error(
          `[schedule] wake alarm sync FAILED after ${MAX_SYNC_ATTEMPTS} attempts — pending wake-ups have no ` +
            `external alarm until the next store change or boot re-mirrors them`,
        );
      }
    } catch (e) {
      // The END of the error path: nothing awaits this loop, so an escape is an unhandled rejection
      // that kills the container. `listWakeups` throws by design on an unreadable store (state.ts),
      // exactly the fault a wake alarm cannot fix — report it and leave the store write untouched,
      // which is this sink's whole contract. The next mutation or boot re-runs the mirror.
      log.error(`[schedule] wake alarm reconcile failed (alarms are stale until the next store change): ${String(e)}`);
    } finally {
      running = false;
      workDone();
    }
  }

  // Single-flight: a save arriving while the loop runs only marks it dirty, so a burst coalesces
  // into one more pass instead of one concurrent loop each.
  return (stateRoot) => {
    dirty = true;
    if (running) return;
    running = true;
    void reconcile(stateRoot);
  };
}
