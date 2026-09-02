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
 *   (health timeout, a permanent config error, exhausted retries).
 */
export type RegistrationOutcome = "registered" | "manual" | "failed";

/**
 * SHARED: how long a registrar waits for the PLATFORM to be able to reach a freshly minted public URL
 * — 8 attempts 10s apart, so 70s of waiting. One judgement (a new tunnel/container's warm-up), so one
 * pair of numbers: telegram, feishu, slack registration and `add slack` all spend the same budget, and
 * it is part of `deploy --run`'s wall clock once per channel.
 */
export const REGISTRATION_ATTEMPTS = 8;
export const REGISTRATION_RETRY_MS = 10_000;
