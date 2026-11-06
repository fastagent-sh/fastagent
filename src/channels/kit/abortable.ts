/** Waiting that an abort ends: what a connection that retries and reconnects does between its attempts. */

/**
 * Run `fn` when `signal` aborts; the returned function stops listening. A listener that is never removed stays on a
 * signal that lives as long as the connection, and Node warns past ten of them.
 */
export function whenAborted(signal: AbortSignal, fn: () => void): () => void {
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}

/** Wait `ms`, or until `signal` aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const stopListening = whenAborted(signal, () => {
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      stopListening();
      resolve();
    }, ms);
  });
}
