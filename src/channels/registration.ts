/**
 * SHARED: the webhook registrars' outcome. A registrar reports its own FACT; what to do about it (gate
 * the deploy or not, and with what remediation) is the CALLER's policy — `deploy --run` gates on
 * "failed", the tunnel (a long-running dev process) ignores the result entirely.
 *
 * - "registered": the platform accepted the webhook / event URL.
 * - "manual": this run did not fail, but an operator-facing step remains (the registrar printed the
 *   instructions). Two sub-states differ on re-runnability: credentials not configured (re-run after
 *   setting .env DOES auto-register; on the deploy path this is pre-gated by missingSecrets and
 *   unreachable) and a cloud without the config API (the Lark cloud-lag 404 — no re-run can ever
 *   register it; the console is the only path).
 * - "failed": this run ends with the webhook NOT registered, and acting + re-running can fix it
 *   (a permanent config error, or the platform still unable to reach the URL when the retries ran out).
 */
export type RegistrationOutcome = "registered" | "manual" | "failed";

/**
 * SHARED: how long a registrar waits for the PLATFORM to be able to reach a freshly minted public URL.
 * One judgement (a new tunnel's warm-up), so one pair of numbers — telegram, feishu, slack registration
 * and `add slack` all spend it.
 *
 * Sized for a tunnel, which is live before its URL is printed, and applied by {@link retryWhile} as its
 * default. A DEPLOY is slower and its callers pass {@link DEPLOY_REGISTRATION_ATTEMPTS} instead.
 */
const REGISTRATION_ATTEMPTS = 8;
export const REGISTRATION_RETRY_MS = 10_000;

/**
 * What `deploy --run` spends instead: 180s, because a host CLI returns before the deployment serves.
 * `railway up --ci` returns when the BUILD ends — container start, healthcheck and a freshly minted
 * domain's DNS all happen after that, and railway-deploy.live.test.ts allows 180s for exactly this.
 * Registration failure GATES the deploy (registration-gate.ts), so a budget shorter than the host's
 * own start-up turns a working deployment into a re-run instruction.
 *
 * N attempts buy (N - 1) waits — {@link retryWhile} only waits BETWEEN calls — so 180s of patience is
 * 19, not 18. At 18 the last call went out at t=170s and a host that started answering in the final
 * ten seconds was still reported as a deploy to re-run.
 */
export const DEPLOY_REGISTRATION_ATTEMPTS = 19;

/** Sleep on the GLOBAL timer (not `node:timers/promises`) so tests can drive it with fake timers — the
 *  same reason feishu-api.ts does. What must happen BEFORE this wait is the point of `onRetry`. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call, and while `retryable` says the failure is the platform not reaching the URL YET, call again —
 * the one retry loop every registrar spends {@link REGISTRATION_ATTEMPTS} through. Retryability and
 * what a final failure MEANS stay with each platform (their vocabularies differ, and one registrar's
 * terminal state is another's `"manual"`); the counting, the announcement and the wait do not.
 *
 * `onRetry` runs BEFORE the wait — registrars announce there (a silent minute reads as a hang), and
 * `add slack` also drops its duplicate-guard marker so it never spans a sleep. The last error is
 * thrown, so a caller can tell "still unreachable" from "a config error" in one place.
 */
export async function retryWhile<T>(
  call: () => Promise<T>,
  retryable: (error: unknown) => boolean,
  options: {
    attempts?: number;
    retryMs?: number;
    onRetry?: (info: { attempt: number; attempts: number; error: unknown }) => void;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? REGISTRATION_ATTEMPTS;
  const retryMs = options.retryMs ?? REGISTRATION_RETRY_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      options.onRetry?.({ attempt, attempts, error });
      await wait(retryMs);
    }
  }
}
