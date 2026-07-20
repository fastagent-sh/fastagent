/**
 * The remote `SessionControl` — the client half of the Phase 3 transport (design §13). Engine- and
 * server-neutral: speaks only the wire protocol `controlRoutes` serves (HTTP JSON + SSE with the
 * {sessionId, epoch, seq, event} envelope) and re-exposes the SAME `SessionControl` interface, so
 * local and remote consumers are isomorphic — client code does not change when the agent moves out
 * of process.
 *
 * Envelope consumption is internal: a seq gap (loss in transit on this connection) ENDS the events
 * iterator — the consumer then runs the standard reconnect steps (`entries({ since })` → `state()`
 * → resubscribe), exactly as after any disconnect. A server RESTART is covered by the same rule
 * (its connections drop); the envelope's `epoch` is informational for consumers that correlate
 * ACROSS connections — within one connection it cannot change, so this client does not compare it.
 * Nothing here retries silently: a broken stream is visible as a terminated iterator, a failed
 * request as a rejected promise.
 */
import { log } from "./log.ts";
import type { SessionCapabilities, SessionControl, SessionEntries, SessionEvent, SessionState } from "./session.ts";

/** A control request the server answered with a non-2xx status. Carries the STRUCTURED status so a
 *  consumer distinguishing auth failure (401 — stale token, unrecoverable) from transient transport
 *  trouble branches on `status`, never on message prose. */
export class ControlRequestError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`control request failed: ${status} ${body}`);
    this.status = status;
  }
}

export interface ConnectSessionControlOptions {
  /** Base URL of the serving process (e.g. `http://127.0.0.1:8787`); `/control/*` is appended. */
  url: string;
  /** The shared bearer secret (`<stateRoot>/control.json` on the serving machine). */
  token: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Connect and return a remote `SessionControl`. Async because `capabilities()` is synchronous in
 * the contract: the static declaration is fetched ONCE here and served from memory — which also
 * makes a wrong URL/token fail at connect time, not on first use.
 */
export async function connectSessionControl(options: ConnectSessionControlOptions): Promise<SessionControl> {
  const { url, token, fetchFn = fetch } = options;
  const base = url.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${token}` };

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchFn(`${base}${path}`, { headers });
    if (!res.ok) throw new ControlRequestError(res.status, await res.text());
    return (await res.json()) as T;
  };

  const capabilities = await get<SessionCapabilities>("/control/capabilities");

  return {
    capabilities: () => capabilities,

    state: (session) => get<SessionState>(`/control/state?session=${encodeURIComponent(session)}`),

    entries: (session, opts) =>
      get<SessionEntries>(
        `/control/entries?session=${encodeURIComponent(session)}${
          opts?.since !== undefined ? `&since=${encodeURIComponent(opts.since)}` : ""
        }`,
      ),

    async dispatch(session, command) {
      const res = await fetchFn(`${base}/control/dispatch`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ session, command }),
      });
      if (!res.ok) throw new ControlRequestError(res.status, await res.text());
      return (await res.json()) as Awaited<ReturnType<SessionControl["dispatch"]>>;
    },

    events(session): AsyncIterable<SessionEvent> {
      // Each ITERATION opens its own connection (gen/abort created inside asyncIterator), matching
      // the local hub's "every iteration is a fresh subscription" — a shared single-use generator
      // would make the second for-await silently empty, breaking local/remote isomorphism.
      // The abort controller lives OUTSIDE the generator: a consumer's `return()`/`break` while the
      // generator is suspended on a quiet SSE read must abort the fetch FIRST — an async generator's
      // own finally only runs after the pending await settles, which a silent stream never does.
      const openStream = (abort: AbortController) =>
        (async function* iterate(): AsyncGenerator<SessionEvent> {
          try {
            const res = await fetchFn(`${base}/control/events?session=${encodeURIComponent(session)}`, {
              headers,
              signal: abort.signal,
            });
            if (!res.ok) throw new ControlRequestError(res.status, await res.text());
            if (!res.body) throw new Error("control events: response has no body");
            let nextSeq = 0;
            for await (const data of sseData(res.body)) {
              const wire = JSON.parse(data) as { sessionId: string; epoch: string; seq: number; event: SessionEvent };
              // Envelope checks — consumed HERE, surfaced only as iterator termination. (epoch is not
              // compared: it cannot change within one connection — see the header note.)
              if (wire.seq !== nextSeq) {
                // Fail visibly: a gap-terminated stream must be distinguishable from a clean end in
                // the diagnostics, even though both surface as iterator termination + resync.
                log.warn(
                  `[fastagent] control events: sequence gap (expected ${nextSeq}, got ${wire.seq}) — ending the stream for resync`,
                );
                return;
              }
              nextSeq = wire.seq + 1;
              yield wire.event;
            }
          } catch (error) {
            if (abort.signal.aborted) return; // the consumer walked away — clean end, not an error
            throw error;
          }
        })();
      return {
        [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
          const abort = new AbortController();
          const gen = openStream(abort);
          return {
            next: () => gen.next(),
            async return(value?: unknown) {
              abort.abort(); // unblocks a generator suspended on the stream read
              await gen.return(value as never).catch(() => {});
              return { done: true as const, value: undefined };
            },
            throw: (error?: unknown) => gen.throw(error),
          };
        },
      };
    },
  };
}

/** Minimal SSE reader: yields each `data:` payload; ignores comments (heartbeats) and other fields. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data !== "") yield data;
      sep = buffer.indexOf("\n\n");
    }
  }
}
