/**
 * Per-instance work tracker counting unsettled message turns and active remote auth flows.
 * Each opened agent instance owns its own tracker so concurrent instances in one process never
 * report another instance's work as busy.
 */
export interface WorkTracker {
  begin(): () => void;
  active(): number;
}

/** Create an isolated work tracker for one agent instance. */
export function createWorkTracker(): WorkTracker {
  let inFlight = 0;
  return {
    begin() {
      inFlight += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        inFlight -= 1;
      };
    },
    active: () => inFlight,
  };
}
