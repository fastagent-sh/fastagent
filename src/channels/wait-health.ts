/**
 * Readiness probe shared by the webhook registrars (telegram setWebhook, lark config PATCH): both
 * platforms VERIFY the URL at registration time, and a fresh deploy's container or a fresh tunnel's
 * DNS is not routable for some seconds — registering before the server actually serves would fail.
 * Tracking real readiness (not a fixed timer) is what fixes that race.
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
