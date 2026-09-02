/**
 * Readiness probe for a server THIS process can reach directly — the local port `deploy docker --run`
 * just published, and the live probes' own origins.
 *
 * NOT a probe for a public URL a platform must reach: a freshly minted hostname (a quick tunnel, a
 * fresh deploy) is routinely unreachable from here for a minute or more while the platform reaches it
 * fine, and polling it hard from t+0 makes that worse (#421). The webhook registrars therefore let the
 * platform's own URL verification be the probe, retried, instead of gating on this.
 */
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Poll `healthUrl` until it responds 200, or the timeout elapses. Any error (not routable yet, DNS not
 * settled, connection refused) is a "keep waiting", not a failure — that IS the readiness signal. Each
 * probe has its own short timeout so one slow attempt can't eat the whole budget.
 */
export async function waitForHealth(healthUrl: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(healthUrl, { signal: AbortSignal.timeout(5000) })).ok) return true;
    } catch {
      /* not routable yet — keep polling until the deadline */
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
