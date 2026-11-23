/**
 * Synchronous, monotonic close-start signal shared by runtimes and the HTTP service surface.
 * Listeners run once when shutdown begins (before async cleanup settles) and must not block.
 */
import { log } from "./log.ts";

export interface CloseSignal {
  /** Whether shutdown has started. */
  isClosing(): boolean;
  /** Transition to closing and synchronously notify registered listeners once. */
  mark(): void;
  /** Subscribe to close start; invokes `listener` synchronously if already closing. */
  subscribe(listener: () => void): () => void;
}

export function createCloseSignal(): CloseSignal {
  let closing = false;
  const listeners = new Set<() => void>();

  const notify = (listener: () => void): void => {
    try {
      listener();
    } catch (error: unknown) {
      log.warn(`[fastagent] close listener failed: ${String(error)}`);
    }
  };

  return {
    isClosing: () => closing,
    mark: () => {
      if (closing) return;
      closing = true;
      for (const listener of [...listeners]) notify(listener);
      listeners.clear();
    },
    subscribe: (listener) => {
      if (closing) {
        notify(listener);
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
