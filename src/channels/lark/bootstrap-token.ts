/**
 * Verification-Token bootstrap — the token has NO read API (field-tested 2026-07: the v6 app detail
 * never returns `encryption`, and the v7 config route only supports PATCH). The platform's only
 * programmatic delivery is the `url_verification` challenge it POSTs to the request URL while an
 * event-subscription PATCH is verified — the challenge body carries `token`, the app's Verification
 * Token. So `add feishu`'s create flow finishes the job by: standing up a throwaway local responder,
 * exposing it on an ephemeral quick tunnel, PATCHing the app's event subscription at it, capturing
 * the token from the challenge, and tearing everything down. `dev --tunnel` / `deploy … --run`
 * re-PATCH the request URL onto the real server later (the token is app-level and survives that).
 *
 * Security: the serving path keeps its strict non-empty-token requirement — no bootstrap mode there.
 * The throwaway URL is random (unguessable), lives for seconds, and only the FIRST challenge is
 * accepted, immediately after our own credential-authenticated PATCH.
 */
import { createServer } from "node:http";
import { waitForHealth } from "../wait-health.ts";

/** What the bootstrap needs from the API pipeline (subset of LarkApi; injectable in tests). */
interface EventSubscriptionPatcher {
  updateEventSubscription(appId: string, cfg: { subscriptionType: "webhook"; requestUrl: string }): Promise<void>;
}

export interface BootstrapTokenOptions {
  api: EventSubscriptionPatcher;
  appId: string;
  /** Expose local `port` on a public URL (production: startCloudflareTunnel; tests: loopback). */
  startTunnel: (port: number) => Promise<{ url: string; close(): void } | undefined>;
  /** Budget for the whole capture (the challenge normally lands within the PATCH round-trip). */
  timeoutMs?: number;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  /** PATCH attempts × delay — the PATCH is the real readiness probe (see below). */
  patchAttempts?: number;
  patchRetryMs?: number;
  /** Retry classifier. Default: retry every PATCH failure (Feishu edge warm-up compatibility).
   * Lark onboarding rejects a definitive config-route 404 immediately so it can fall back by hand. */
  shouldRetryPatch?: (error: unknown) => boolean;
}

/**
 * Run the bootstrap (module header). Resolves with the app's Verification Token; rejects with a
 * plain, actionable Error (tunnel unavailable, PATCH refused, challenge never arrived) — the caller
 * degrades to the manual console instruction.
 */
export async function bootstrapVerificationToken(options: BootstrapTokenOptions): Promise<string> {
  let capturedToken: ((token: string) => void) | undefined;
  const token = new Promise<string>((resolve) => {
    capturedToken = resolve;
  });

  // The throwaway responder: answers /health (tunnel readiness) and the url_verification challenge
  // (echo `challenge` back), capturing `token` from the FIRST challenge only.
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.end("ok");
      return;
    }
    let body = "";
    req.on("data", (d: Buffer) => {
      body += String(d);
    });
    req.on("end", () => {
      try {
        const j = JSON.parse(body) as { type?: string; challenge?: string; token?: string };
        if (j.type === "url_verification" && typeof j.challenge === "string" && typeof j.token === "string") {
          capturedToken?.(j.token);
          capturedToken = undefined; // first challenge only
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ challenge: j.challenge }));
          return;
        }
      } catch {
        /* not the challenge — fall through to the empty ACK */
      }
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const tunnel = await options.startTunnel(port);
  try {
    if (!tunnel) throw new Error("no tunnel came up (is cloudflared installed?)");
    // Warm-up only, NON-FATAL: "can WE reach the edge" is the wrong readiness signal — the challenge
    // travels platform→edge, an independent path (field-tested: local negative-DNS caching kept this
    // probe failing while the platform's challenge went through fine). The PATCH below is the real
    // probe: it succeeds only once the platform reached the URL and got the challenge answered — so
    // it is retried on failure while the edge warms up.
    await waitForHealth(`${tunnel.url}/health`, options.readyTimeoutMs ?? 45_000, options.readyIntervalMs ?? 2_000);
    const attempts = options.patchAttempts ?? 8;
    for (let attempt = 1; ; attempt++) {
      try {
        await options.api.updateEventSubscription(options.appId, {
          subscriptionType: "webhook",
          requestUrl: `${tunnel.url}/lark`,
        });
        break;
      } catch (e) {
        if (attempt >= attempts || options.shouldRetryPatch?.(e) === false) throw e;
        await new Promise((resolve) => setTimeout(resolve, options.patchRetryMs ?? 10_000));
      }
    }
    const winner = await Promise.race([
      token,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), options.timeoutMs ?? 30_000)),
    ]);
    if (winner === undefined) throw new Error("the registration challenge never arrived");
    return winner;
  } finally {
    tunnel?.close();
    server.close();
  }
}
