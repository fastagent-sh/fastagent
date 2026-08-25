/**
 * SHARED process-wide in-flight work signal. Channels ACK a webhook fast and run the turn
 * fire-and-forget on this process's event loop (serve.ts) — so "is this process busy?" is not
 * derivable from open HTTP requests. The two shared execution primitives (turn-queue chains,
 * task-tracker side tasks) report here; a serving surface that must stay alive while background
 * work runs (the AgentCore adapter's /ping → HealthyBusy) reads it.
 *
 * Deliberately a counter, not a registry: consumers need only "any work in flight?"; keeping the
 * module dependency-free lets both channel primitives import it without cycles.
 */

let inFlight = 0;
const idleListeners = new Set<() => void>();

/**
 * Mark one unit of background work as started. Returns its completion callback — idempotent, so a
 * caller may safely settle it from multiple cleanup paths (finally + catch) without double-counting.
 */
export function beginWork(): () => void {
  inFlight += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inFlight -= 1;
    if (inFlight > 0) return;
    for (const listener of idleListeners) {
      // A listener fault must not corrupt the counter or starve the others (this runs inside a
      // channel's `finally`): report and carry on.
      try {
        listener();
      } catch (e) {
        console.error(`[fastagent] idle listener failed: ${String(e)}`);
      }
    }
  };
}

/**
 * Subscribe to the 0-in-flight edge: the moment the process finishes its last background turn.
 * Returns an unsubscribe. Used by the AgentCore adapter to push its state snapshot exactly when the
 * state root has settled and before the platform may reclaim the idle microVM.
 */
export function onIdle(listener: () => void): () => void {
  idleListeners.add(listener);
  return () => {
    idleListeners.delete(listener);
  };
}

/** How many units of background work are currently in flight (0 = idle). */
export function activeWork(): number {
  return inFlight;
}
