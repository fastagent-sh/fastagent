/**
 * SHARED: the webhook registrars' outcome. A registrar reports its own FACT; what to do about it is the CALLER's
 * policy — `deploy --run` gates on "failed", the tunnel ignores the result entirely.
 *
 * - `registered`: the platform accepted the webhook / event URL.
 * - `manual`: this run did not fail, but an operator-facing step remains (the registrar printed it). Re-runnability
 *   differs by sub-state: credentials not configured re-registers on a re-run; a cloud without the config API never
 *   will (the console is the only path).
 * - `failed`: the webhook is NOT registered, and acting plus re-running can fix it.
 */
export type RegistrationOutcome = "registered" | "manual" | "failed";

/** SHARED: how long a registrar waits for the PLATFORM to be able to reach a freshly minted public URL. */
const REGISTRATION_ATTEMPTS = 8;
export const REGISTRATION_RETRY_MS = 10_000;

/** What `deploy --run` spends instead: 180s, because a host CLI returns before the deployment serves. */
export const DEPLOY_REGISTRATION_ATTEMPTS = 19;

/**
 * Sleep on the GLOBAL timer (not `node:timers/promises`) so tests can drive it with fake timers — the same reason
 * feishu-api.ts does.
 */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Call, and while `retryable` says the failure is the platform not reaching the URL YET, call again. */
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
