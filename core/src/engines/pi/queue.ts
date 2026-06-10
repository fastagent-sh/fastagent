/**
 * Single-consumer async queue — push→pull plumbing dedicated to pi's two-port shape
 * (subscribe pushes + prompt resolves). It exists because of that shape: engines that
 * are natively async-iterable (e.g. the claude SDK) would not need it.
 * Single-threaded JS: no await interleaves between push and drain, so no locking.
 */
export class EventQueue<T> {
  private buffer: T[] = [];
  private wake?: () => void;

  push(item: T): void {
    this.buffer.push(item);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /**
   * Yield pushed events in order until `done` settles AND the buffer is drained.
   * Does not yield the result of `done` — the terminal is produced separately by the
   * caller (toTerminal). Rejections of `done` are swallowed here (the caller awaits
   * `run` itself) to avoid unhandled rejections.
   */
  async *drainUntil(done: Promise<unknown>): AsyncGenerator<T> {
    let settled = false;
    const onSettle = () => {
      settled = true;
      const wake = this.wake;
      this.wake = undefined;
      wake?.();
    };
    const finished = done.then(onSettle, onSettle);

    while (true) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
      }
      if (settled) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    await finished;
  }
}
