/** Webhooks ACK before background turns finish, so open requests cannot determine runtime idleness. */
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
