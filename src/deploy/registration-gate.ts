/**
 * Host-NEUTRAL step-7 gate policy, shared by the host runners: the registrars report facts ({@link
 * RegistrationOutcome}), this module owns what to do about them.
 */
import type { RegistrationOutcome } from "../channels/registration.ts";

export function registrationGate(
  log: (msg: string) => void,
  retryHint: string,
): {
  track: (kind: string, outcome: RegistrationOutcome) => void;
  /**
   * Logs the manual notices; returns the gate message (composes with cli.ts's "deploy stopped:" prefix — it leads with
   * the failure, not "the deploy succeeded"), or undefined for no gate.
   */
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
