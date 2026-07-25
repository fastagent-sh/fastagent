/**
 * SHARED: make concurrent duplicate deliveries of one message share ONE acceptance.
 *
 * Chat platforms redeliver an event whose ACK they did not see in time, and some emit the same message
 * through two subscriptions. Once acceptance awaits a platform read (docs/design/participant-model.md
 * §3), the delivery-dedup ring alone is not enough: two copies can both pass it while the first is
 * still deciding, and both would run the turn. Joining the in-flight acceptance also settles them
 * together — both ACK success, or both leave the delivery re-pushable, never one 200 racing one 500.
 */
export interface InflightAcceptances {
  /** Run `accept` for `key`, or join the one already running for it. */
  join(key: string, accept: () => Promise<void>, onJoin?: () => void): Promise<void>;
}

export function createInflightAcceptances(): InflightAcceptances {
  const inflight = new Map<string, Promise<void>>();
  return {
    join(key, accept, onJoin) {
      const pending = inflight.get(key);
      if (pending !== undefined) {
        onJoin?.();
        return pending;
      }
      const started = accept().finally(() => inflight.delete(key));
      inflight.set(key, started);
      return started;
    },
  };
}
