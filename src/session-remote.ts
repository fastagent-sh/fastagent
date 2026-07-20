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
import type { Agent, AgentEvent, Prompt } from "./agent.ts";
import { log } from "./log.ts";
import type { WireEvent } from "./channels/control.ts";
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

  // Non-streaming requests carry a TIMEOUT: attach's whole reliability model counts failed rounds
  // against a budget ("unreachable for ~Ns"), which a black-hole endpoint (firewall drop, half-dead
  // tunnel) would silently defeat — a hung state()/entries() ticks nothing. The SSE stream stays
  // timeout-free (quiet is normal there; heartbeats cover proxy idling).
  const REQUEST_TIMEOUT_MS = 10_000;
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchFn(`${base}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
              // Parse discipline, same as the other two wire planes (dispatch parses, invoke
              // classifies drift): a non-JSON or non-envelope payload is PROTOCOL MISMATCH —
              // thrown, so a consumer's failure budget applies — never misdiagnosed as an
              // in-transit gap whose remedy (reconnect) can never fix it.
              let wire: WireEvent;
              try {
                // The ONE envelope type (control.ts's WireEvent) — an inline shape would let the
                // envelope drift server-side while this cast silently kept the old fields.
                wire = JSON.parse(data) as WireEvent;
              } catch (parseError) {
                throw new Error(
                  `control events: non-JSON data on the stream (${String(parseError)}) — protocol mismatch?`,
                );
              }
              if (typeof wire.seq !== "number" || typeof wire.event !== "object" || wire.event === null) {
                throw new Error(
                  "control events: malformed envelope — the endpoint does not speak this protocol version",
                );
              }
              // Envelope checks — consumed HERE, surfaced only as iterator termination. (epoch is
              // not compared: it cannot change within one connection — see the header note.)
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
            async throw(error?: unknown): Promise<IteratorResult<SessionEvent>> {
              // throw = terminate with the caller's error: tear the connection down exactly like
              // return() (abort first — gen.throw would queue behind a quiet read), then rethrow
              // deterministically instead of poking a completed generator.
              abort.abort();
              await gen.return(undefined as never).catch(() => {});
              throw error;
            },
          };
        },
      };
    },
  };
}

/**
 * The remote DATA plane: an `Agent` whose `invoke` drives `POST /control/invoke` on a serving
 * process — paired with {@link connectSessionControl}, a client holds a full remote fastagent
 * instance through the same two contracts local code uses. A REAL Agent, failure discipline
 * included: SPEC MUST 2 forbids iteration throws, so every failure — transport (401/refused/
 * dropped mid-stream), protocol, and the images precheck — becomes a terminal `failed` event
 * (`retryable` from the HTTP status where one exists; network trouble is retryable). Breaking out
 * of iteration disconnects the request, which cancels the run (SPEC cancellation semantics travel
 * the wire). The invoke wire is text-only for now: a prompt with images fails visibly instead of
 * silently dropping them (steer/follow_up on the control plane carry full Prompts).
 */
export function connectAgent(options: ConnectSessionControlOptions): Agent {
  const { url, token, fetchFn = fetch } = options;
  const base = url.replace(/\/$/, "");
  const toFailed = (error: unknown): AgentEvent => {
    if (error instanceof ControlRequestError) {
      return { type: "failed", details: error.message, retryable: error.status === 429 || error.status >= 500 };
    }
    return { type: "failed", details: String(error), retryable: true }; // network-class: worth re-sending
  };
  // COMPILE-TIME drift guard (dispatch-wire parity): the invoke body carries exactly text (and
  // rejects images visibly) — a new Prompt field must break THIS line and force a decision
  // (carry it or reject it), never vanish on the wire while the client believes it was sent.
  const _invokeDriftGuard: Record<Exclude<keyof Prompt, "text" | "images">, never> = {};
  void _invokeDriftGuard;
  return {
    invoke(scope, prompt): AsyncIterable<AgentEvent> {
      const abort = new AbortController();
      const openStream = () =>
        (async function* iterate(): AsyncGenerator<AgentEvent> {
          if (prompt.images && prompt.images.length > 0) {
            yield {
              type: "failed",
              details: "remote invoke does not carry images yet — send text, or invoke in-process",
              retryable: false,
            };
            return;
          }
          // Exactly-one-terminal discipline across the wire: a drop AFTER the server's terminal
          // must not append a second one (catch included), and a stream that ends WITHOUT one
          // (server died mid-run) must be closed with a failed — never a terminal-less end.
          let terminalSeen = false;
          try {
            const res = await fetchFn(`${base}/control/invoke`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ session: scope.session, text: prompt.text }),
              signal: abort.signal,
            });
            if (!res.ok) {
              yield toFailed(new ControlRequestError(res.status, await res.text()));
              return;
            }
            if (!res.body) {
              yield { type: "failed", details: "remote invoke: response has no body", retryable: true };
              return;
            }
            for await (const data of sseData(res.body)) {
              let event: AgentEvent;
              try {
                event = JSON.parse(data) as AgentEvent;
              } catch (parseError) {
                // Protocol drift (version skew, non-SSE middlebox), NOT transport trouble:
                // re-sending the same prompt cannot fix an unparseable stream — retryable: false.
                // (Guarded by terminalSeen: garbage AFTER the terminal must not add a second one.)
                if (!terminalSeen) {
                  yield {
                    type: "failed",
                    details: `remote invoke: unparseable event on the stream (${String(parseError)})`,
                    retryable: false,
                  };
                }
                return;
              }
              if (event.type === "completed" || event.type === "failed") terminalSeen = true;
              yield event;
            }
            if (!terminalSeen) {
              yield { type: "failed", details: "remote invoke: stream ended without a terminal", retryable: true };
            }
          } catch (error) {
            if (abort.signal.aborted) return; // the consumer walked away — cancellation, not an error
            if (!terminalSeen) yield toFailed(error);
          }
        })();
      // ONE stream per invoke, like a local async generator (which is its own iterator): a second
      // iteration must never re-POST — that would silently start a second run with the same prompt.
      const gen = openStream();
      return {
        [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          return {
            next: () => gen.next(),
            async return(value?: unknown) {
              abort.abort(); // disconnect = cancel the run, even while suspended on a quiet read
              await gen.return(value as never).catch(() => {});
              return { done: true as const, value: undefined };
            },
            async throw(error?: unknown): Promise<IteratorResult<AgentEvent>> {
              abort.abort();
              await gen.return(undefined as never).catch(() => {});
              throw error;
            },
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
    // SSE permits CRLF line endings (proxies/other servers may produce them); normalize AFTER
    // appending so a \r\n split across chunks still collapses once its second half arrives.
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
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
