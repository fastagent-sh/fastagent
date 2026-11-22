/**
 * The process's work in flight: every message not yet settled (counted by the Agent, pi-durable/agent.ts) and active
 * remote auth flows. Open requests cannot tell whether the process is idle; this can. Read by `dev`'s restart and
 * AgentCore's `/ping`.
 */
let inFlight = 0;

/** Mark background work as started. */
export function beginWork(): () => void {
  inFlight += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inFlight -= 1;
  };
}

export function activeWork(): number {
  return inFlight;
}
