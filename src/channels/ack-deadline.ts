/**
 * SHARED: cap a pre-ACK platform wait so a slow read cannot stall an event acknowledgement.
 *
 * Chat platforms require an event callback to be acknowledged within a few seconds, while the
 * participant model needs a platform read before it can tell an ask from background discussion
 * (docs/design/participant-model.md §3). One budget covers ALL of a delivery's platform waits, so the
 * caller passes an absolute `deadline` rather than a per-wait timeout: two sequential waits must not
 * each get the full allowance.
 */

/**
 * Race `work` against the delivery's shared `deadline` (epoch ms).
 *
 * `work` may be abandoned by the race; its own late rejection is muted so it cannot surface as an
 * unhandled rejection, and `onTimeout` lets the caller cancel it (an abandoned request left running
 * would otherwise ride the API pipeline's full timeout and retry budget).
 */
export async function withAckDeadline<T>(
  work: Promise<T>,
  what: string,
  deadline: number,
  budgetMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  Promise.resolve(work).catch(() => {});
  // The budget is SHARED, so this wait's own share is whatever is left — report that, not the
  // constant, or an operator reads every timeout as a full-budget stall.
  const share = Math.max(0, deadline - Date.now());
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${what} exceeded its ${share}ms share of the ${budgetMs}ms pre-ACK budget`));
        }, share);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
