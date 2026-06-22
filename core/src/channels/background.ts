/**
 * The `background` port (Caller-side): run a task to completion AFTER the caller has detached
 * (e.g. a webhook that already returned 202).
 *
 * It is the symmetric twin of the Agent-side dependency-inversion ports (sessions/env/lease/
 * auth): the Agent has host dependencies injected into it, and so does a Caller — its execution
 * lifetime. It lives OUTSIDE the invoke contract (adds no scope field, no event, no invoke
 * parameter; the Agent never sees it) and is NOT Middleware. In WSGI/ASGI terms it is the
 * server's background-task / lifespan layer, not the app callable.
 *
 * NOT a universal tax: only ACK-early channels (webhook-like) need it. Channels whose caller
 * awaits the result (SSE, buffered embed, CLI) get liveness for free from the open connection /
 * blocked request and never touch this port.
 */

/**
 * Run `task` to completion after the caller has detached. The implementation MUST carry a
 * completion guarantee: `(t) => void t()` is ILLEGAL — once the response is sent the runtime may
 * reclaim the process and the task dies mid-flight. The completion guarantee is the entire reason
 * this port exists; how it is honored (track in-flight, durable queue, host primitive) is the
 * host's choice.
 */
export type BackgroundRunner = (task: () => Promise<void>) => void;

/**
 * Reference single-instance {@link BackgroundRunner}: track in-flight tasks so a graceful shutdown
 * can drain them instead of killing turns mid-flight. Channel-agnostic — any ACK-early channel can
 * use it. Multi-instance / crash-durable runners (queue + worker, a platform's async invocation)
 * are host-specific and live outside core.
 *
 * `drain()` awaits all in-flight tasks — call it on SIGTERM before exiting. A task that throws is
 * settled (not propagated) so one failure cannot wedge the drain, and is surfaced via `onTaskError`
 * (default console.error: fail visibly, never swallow).
 */
export function createTrackedBackground(options: { onTaskError?: (error: unknown) => void } = {}): {
  background: BackgroundRunner;
  drain: () => Promise<void>;
} {
  const onTaskError =
    options.onTaskError ?? ((error: unknown) => console.error(`[fastagent] background task failed: ${String(error)}`));
  const inFlight = new Set<Promise<void>>();
  const background: BackgroundRunner = (task) => {
    const p = task()
      .catch(onTaskError)
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  };
  return {
    background,
    drain: () => Promise.allSettled([...inFlight]).then(() => undefined),
  };
}
