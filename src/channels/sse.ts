/** Shared SSE response lifecycle for invoke and session observation. */

/** The remote client's idle watchdog allows three missed heartbeats. */
export const SSE_HEARTBEAT_MS = 30_000;

const encoder = new TextEncoder();
const heartbeat = encoder.encode(": ping\n\n");

/** `idOf` names an event's SSE `id`, which a reconnecting browser sends back as `Last-Event-ID`. */
export function sseResponse<T>(
  events: AsyncIterable<T>,
  project: (event: T) => unknown = (event) => event,
  idOf: (event: T) => string | undefined = () => undefined,
): Response {
  const iterator = events[Symbol.asyncIterator]();
  // Subscribe before headers; synchronous startup errors belong to the HTTP error boundary.
  let pending: Promise<IteratorResult<T>> | undefined = Promise.resolve(iterator.next());
  // pull() surfaces asynchronous failures. Observe rejection even if the caller cancels before that pull.
  pending.catch(() => {});
  let closed = false;
  let timer: ReturnType<typeof setInterval>;
  const stop = (): void => {
    closed = true;
    clearInterval(timer);
  };
  const cancel = async (): Promise<void> => {
    if (closed) return;
    stop();
    await iterator.return?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => controller.enqueue(heartbeat), SSE_HEARTBEAT_MS);
    },
    async pull(controller) {
      try {
        const next = await (pending ?? iterator.next());
        pending = undefined;
        // Cancellation can settle a pending next(); its value no longer has a reader.
        if (closed) return;
        if (next.done) {
          stop();
          controller.close();
        } else {
          const id = idOf(next.value);
          // An id is one line: a newline in it would end the field and start another.
          const field = id === undefined ? "" : `id: ${id.replace(/[\r\n]/g, "")}\n`;
          controller.enqueue(encoder.encode(`${field}data: ${JSON.stringify(project(next.value))}\n\n`));
        }
      } catch (error) {
        if (closed) return;
        // Errored streams never call cancel(), so iterator and timer cleanup belongs here too.
        try {
          await cancel();
        } catch (cleanupError) {
          controller.error(
            new AggregateError([error, cleanupError], "SSE source and cleanup failed", { cause: error }),
          );
          return;
        }
        controller.error(error);
      }
    },
    cancel,
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
