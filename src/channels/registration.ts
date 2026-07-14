/**
 * SHARED: the webhook registrars' outcome. A registrar reports its own FACT; what to do about it (gate
 * the deploy or not, and with what remediation) is the CALLER's policy — `deploy --run` gates on
 * "failed", the tunnel (a long-running dev process) ignores the result entirely.
 *
 * - "registered": the platform accepted the webhook / event URL.
 * - "manual": manual setup is the designed path — credentials not configured, or a cloud without the
 *   config API (the Lark cloud-lag 404). Re-running cannot change it, so it must NOT become a
 *   re-run-to-clear gate; the caller surfaces the manual step instead.
 * - "failed": this run ends with the webhook NOT registered, and acting + re-running can fix it
 *   (health timeout, a permanent config error, exhausted retries).
 */
export type RegistrationOutcome = "registered" | "manual" | "failed";
