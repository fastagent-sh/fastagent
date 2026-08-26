/**
 * Host-NEUTRAL step-7 gate policy, shared by the host runners: the registrars report facts
 * ({@link RegistrationOutcome}), this module owns what to do about them.
 *
 * - "failed" gates — exit 0 would tell a coding agent "done" while the deployed agent cannot receive
 *   messages, and the runners' earlier steps are idempotent so a re-run just retries registration.
 * - "manual" does NOT gate — re-running can never change it (an unclearable gate would spin a coding
 *   agent forever) — but is re-surfaced after all registrar output (and before any gate message) so
 *   the operator cannot miss it under the registrar's earlier log lines.
 *
 * The runners attempt ALL channels first (one failure doesn't skip the rest), then apply this policy
 * once. Only the retry remediation differs per host (`retryHint`).
 */
import type { RegistrationOutcome } from "../channels/registration.ts";

export function registrationGate(
  log: (msg: string) => void,
  retryHint: string,
): {
  track: (kind: string, outcome: RegistrationOutcome) => void;
  /** Logs the manual notices; returns the gate message (composes with cli.ts's "deploy stopped:"
   *  prefix — it leads with the failure, not "the deploy succeeded"), or undefined for no gate. */
  gate: () => string | undefined;
} {
  const unregistered: string[] = [];
  const manual: string[] = [];
  return {
    track(kind, outcome) {
      if (outcome === "failed") unregistered.push(kind);
      if (outcome === "manual") manual.push(kind);
    },
    gate() {
      for (const kind of manual) {
        log(`${kind}: webhook registration needs a one-time manual step — see the instructions above`);
      }
      if (unregistered.length === 0) return undefined;
      return `webhook registration failed for: ${unregistered.join(", ")} — the app itself deployed; fix the error above, then ${retryHint}`;
    },
  };
}
