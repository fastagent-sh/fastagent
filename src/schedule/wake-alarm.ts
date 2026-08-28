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
 * Reconciliation is DECLARATIVE (the full pending set travels each time) and deletion is lazy: a
 * cancelled wake-up's alarm still fires its poke, finds nothing due, and self-deletes — a harmless
 * wasted wake-up of the box, traded for never needing list/delete choreography.
 */
import { readFileSync } from "node:fs";
import { beginWork } from "../channels/busy.ts";
import { log } from "../log.ts";
import { scheduleFile, writeScheduleFile } from "./state.ts";
import { type Wakeup, listWakeups } from "./wakeups.ts";

/** The forwarder's reserved wake-alarm path — never forwarded to channel routes. */
export const WAKE_ALARM_PATH = "/__fastagent/wake-alarm";

/** One desired alarm: mirror of a pending wake-up (id names the EventBridge schedule; at = fireAt). */
export interface WakeAlarm {
  id: string;
  at: string;
}

/** The wire shape the sink POSTs to {@link WAKE_ALARM_PATH} (the forwarder validates `secret`). */
export interface WakeAlarmRequest {
  secret: string;
  alarms: WakeAlarm[];
}

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
 */
export function createWakeAlarmSink(options: {
  secret: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => Date;
  /** Injectable retry pause (tests); defaults to exponential-ish backoff off RETRY_BASE_MS. */
  delay?: (ms: number) => Promise<void>;
}): (stateRoot: string, pending: Wakeup[]) => void {
  const { secret, fetchImpl = fetch, now = () => new Date() } = options;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Supersession token: a newer mutation's sync REPLACES an older one still retrying — without it,
  // an old in-flight set could win the race and mirror stale state.
  let latest: symbol | undefined;

  async function sync(url: string, body: WakeAlarmRequest, token: symbol): Promise<void> {
    // Counted as in-flight work: the retry loop is exactly the window where the box must not be
    // reclaimed — idle away mid-retry and a pending wake has no alarm until the next boot.
    const workDone = beginWork();
    try {
      for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
        if (latest !== token) return; // superseded by a newer set — that sync owns correctness now
        try {
          const res = await fetchImpl(`${url.replace(/\/$/, "")}${WAKE_ALARM_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
          });
          if (res.ok) return;
          log.warn(`[schedule] wake alarm sync attempt ${attempt}/${MAX_SYNC_ATTEMPTS} failed: HTTP ${res.status}`);
        } catch (e) {
          log.warn(`[schedule] wake alarm sync attempt ${attempt}/${MAX_SYNC_ATTEMPTS} failed: ${String(e)}`);
        }
        await delay(RETRY_BASE_MS * attempt);
      }
      log.error(
        `[schedule] wake alarm sync FAILED after ${MAX_SYNC_ATTEMPTS} attempts — pending wake-ups have no ` +
          `external alarm until the next store change or boot re-mirrors them`,
      );
    } finally {
      workDone();
    }
  }

  return (stateRoot, pending) => {
    const url = readWakeAlarmUrl(stateRoot);
    if (!url) {
      // First-ever boot before any envelope: nothing to call yet. The wake itself is stored; the
      // alarm catches up on the next store mutation after an envelope has arrived.
      log.warn("[schedule] wake alarm skipped — forwarder URL not seen yet (it arrives with the first envelope)");
      return;
    }
    const alarms = toAlarms(pending, now());
    if (alarms.length === 0) return; // nothing future to mirror (deletion is lazy by design)
    const token = Symbol("wake-alarm-sync");
    latest = token;
    void sync(url, { secret, alarms }, token);
  };
}

/**
 * One boot-time reconcile: pending wake-ups may exist while their alarms were lost (a deploy
 * replaced the forwarder, a sink call failed) — re-mirror the current set once at start.
 */
export function reconcileWakeAlarms(stateRoot: string, sink: (stateRoot: string, pending: Wakeup[]) => void): void {
  const pending = listWakeups(stateRoot);
  if (pending.length > 0) sink(stateRoot, pending);
}
