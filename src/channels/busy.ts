/**
 * The process's work in flight: every session a lease holds (a turn or compaction, however it started), and the
 * channel, schedule and AgentCore work that has not reached one yet. Webhooks ACK before their turns finish, so open
 * requests cannot tell whether the process is idle; this can. Read by AgentCore's `/ping` and by `dev`'s restart.
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
