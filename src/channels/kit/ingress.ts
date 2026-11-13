/**
 * Shared channel ingress, abort/retry waiting, and per-call transport retry policy.
 */
import { readBodyCapped } from "../body.ts";
import { text } from "../respond.ts";

/** Per-call transport options (`DROPPABLE_FRAME` / `CONTEXT_READ` opt out of rate-limit retries). */
export interface CallOptions {
  readonly retries?: number;
}

/** A live-preview snapshot superseded by the next frame: never wait out a rate limit for it. */
export const DROPPABLE_FRAME: CallOptions = { retries: 0 };

/** A context-enrichment read the turn can survive without: never wait out a rate limit for it. */
export const CONTEXT_READ: CallOptions = { retries: 0 };

/** Run `fn` when `signal` aborts; returns a cleanup that removes the listener. */
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

/** Whether a Unix-seconds timestamp header is within `maxAgeS` of now. */
export function signatureIsFresh(timestamp: string, maxAgeS: number, nowMs = Date.now()): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  return Number.isSafeInteger(seconds) && Math.abs(Math.floor(nowMs / 1000) - seconds) <= maxAgeS;
}

/** Standard POST-only, body-capped JSON webhook handler with an attached `turnsIdle` test seam. */
export function createJsonWebhookRoute<Body>(options: {
  maxBytes: number;
  turnsIdle: () => Promise<void>;
  /** Validate headers/method before reading body (return a Response to reject early). */
  beforeBody?: (req: Request) => Response | undefined;
  /** Validate raw body (e.g. HMAC signature) BEFORE JSON parsing. */
  verifyRaw?: (req: Request, rawBody: string) => Response | undefined;
  /** Handle parsed payload + exact raw body string. */
  handle: (req: Request, rawBody: string, parsed: Body) => Promise<Response> | Response;
}): ((req: Request) => Promise<Response>) & { turnsIdle: () => Promise<void> } {
  const handler = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return text("POST only\n", 405);
    const early = options.beforeBody?.(req);
    if (early !== undefined) return early;
    const body = await readBodyCapped(req, options.maxBytes);
    if ("tooLarge" in body) return text("payload too large\n", 413);
    const rejected = options.verifyRaw?.(req, body.text);
    if (rejected !== undefined) return rejected;
    let parsed: Body;
    try {
      parsed = JSON.parse(body.text) as Body;
    } catch {
      return text("invalid json\n", 400);
    }
    return options.handle(req, body.text, parsed);
  };
  (handler as typeof handler & { turnsIdle: () => Promise<void> }).turnsIdle = options.turnsIdle;
  return handler as typeof handler & { turnsIdle: () => Promise<void> };
}
