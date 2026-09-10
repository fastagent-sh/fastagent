/**
 * Readiness probe for a server THIS process can reach over HTTP — the local port `deploy docker --run` just
 * published, the live probes' own origins, and the public URL a host deploy must clear before it registers a webhook
 * (`publicHealthGate` in deploy/channel-ingress.ts).
 */
import { setTimeout as sleep } from "node:timers/promises";

/** Poll `healthUrl` until it responds 200, or the timeout elapses. */
export async function waitForHealth(
  healthUrl: string,
  timeoutMs: number,
  intervalMs: number,
  /** Optional liveness answer from whoever runs the server. */
  stillStarting?: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(healthUrl, { signal: AbortSignal.timeout(5000) })).ok) return true;
    } catch {
      // not routable yet — keep polling until the deadline
    }
    if (Date.now() >= deadline) return false;
    if (stillStarting && !(await stillStarting())) return false;
    await sleep(intervalMs);
  }
}
