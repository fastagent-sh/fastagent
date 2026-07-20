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
import type { Agent, AgentEvent, Prompt, Scope } from "./agent.ts";
import { SSE_HEARTBEAT_MS } from "./channels/http.ts";
import { abortFirstIterator } from "./collect.ts";
import type { WireEvent } from "./channels/control.ts";

/** Dead-connection watchdog for SSE reads: the server heartbeats every SSE_HEARTBEAT_MS, so a
 *  PENDING READ seeing no bytes (of ANY kind — comments included) for this many missed beats
 *  means the connection is a black hole. The stream is aborted and surfaced as an error, so a
 *  consumer's failure budget ticks instead of hanging forever. Quiet-but-alive streams (a long
 *  tool call) keep heartbeating and never trip this. */
const SSE_IDLE_LIMIT_MS = 3 * SSE_HEARTBEAT_MS;

/** The watchdog counts only while ARMED — armed means "a read is actually pending" (the connect
 *  awaiting headers, a body read awaiting bytes). It measures connection liveness, NOT consumer
 *  pull progress: a generator parked at `yield` (a slow or paused consumer — rate-limited
 *  rendering, a debugger) is disarmed and never misdiagnosed as a dead connection; killing a
 *  healthy invoke stream would cancel the run it drives. `stale()` reports whether the abort that
 *  ended the stream was the watchdog's own (→ dead-connection error) rather than the consumer
 *  walking away (→ clean end). */
interface ReadWatch {
  arm(): void;
  disarm(): void;
  stale(): boolean;
  stop(): void;
}
function idleWatchdog(abort: AbortController): ReadWatch {
  let armedAt: number | undefined;
  let stale = false;
  const timer = setInterval(() => {
    if (armedAt !== undefined && Date.now() - armedAt > SSE_IDLE_LIMIT_MS) {
      stale = true;
      abort.abort();
    }
  }, SSE_HEARTBEAT_MS);
  return {
    arm: () => {
      armedAt ??= Date.now();
    },
    disarm: () => {
      armedAt = undefined;
    },
    stale: () => stale,
    stop: () => clearInterval(timer),
  };
}
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

/** Connection parameters shared by BOTH remote planes (`connectSessionControl` and
 *  `connectAgent`) — plane-neutral on purpose: one endpoint, one token, two contracts. */
export interface RemoteEndpointOptions {
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
export async function connectSessionControl(options: RemoteEndpointOptions): Promise<SessionControl> {
  const { url, token, fetchFn = fetch } = options;
  const base = url.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${token}` };

  // Non-streaming requests carry a TIMEOUT: attach's whole reliability model counts failed rounds
  // against a budget ("unreachable for ~Ns"), which a black-hole endpoint (firewall drop, half-dead
  // tunnel) would silently defeat — a hung state()/entries() ticks nothing. The SSE stream stays
  // timeout-free (quiet is normal there; heartbeats cover proxy idling).
  const REQUEST_TIMEOUT_MS = 10_000;
  // The PAYLOAD-bearing calls get a longer budget than the black-hole detector's 10s — in both
  // directions: dispatch may UPLOAD up to the 1 MiB body cap (base64 images in steer/follow_up),
  // and entries may DOWNLOAD a long session's full record (a cursor-less first backfill) — a slow
  // link legitimately needs longer, and cutting a healthy transfer would be indistinguishable from
  // a dead endpoint. capabilities/state stay on the short detector: they are small by contract.
  const PAYLOAD_TIMEOUT_MS = 60_000;
  const get = async <T>(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> => {
    const res = await fetchFn(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
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
        PAYLOAD_TIMEOUT_MS, // the download-direction payload call — see the constant's note
      ),

    async dispatch(session, command) {
      const res = await fetchFn(`${base}/control/dispatch`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ session, command }),
        signal: AbortSignal.timeout(PAYLOAD_TIMEOUT_MS),
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
          // Armed BEFORE the fetch: the connect phase (headers never arriving from a black-holed
          // endpoint) is otherwise a window no timeout covers — the same watchdog terminates it,
          // with headers-arrival counting as the first sign of life.
          const watchdog = idleWatchdog(abort);
          watchdog.arm(); // the connect await is a pending read
          try {
            const res = await fetchFn(`${base}/control/events?session=${encodeURIComponent(session)}`, {
              headers,
              signal: abort.signal,
            });
            watchdog.disarm(); // headers arrived
            if (!res.ok) {
              // The error body is a pending read too — a half-dead tunnel serving 4xx headers then
              // black-holing the body must not hang the round outside every budget. Re-armed: the
              // watchdog aborts the read and the round fails with the dead-connection diagnosis.
              watchdog.arm();
              throw new ControlRequestError(res.status, await res.text());
            }
            if (!res.body) throw new Error("control events: response has no body");
            let nextSeq = 0;
            for await (const data of sseData(res.body, watchdog)) {
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
              // Envelope checks — consumed HERE. (epoch is not compared: it cannot change within
              // one connection — see the header note.) A gap THROWS like a protocol mismatch: the
              // consumer's failure path (budget, its own io) owns the diagnostic — a library-level
              // log would bypass consumer output discipline, and a silent clean end would be
              // indistinguishable from the server closing normally.
              if (wire.seq !== nextSeq) {
                throw new Error(
                  `control events: sequence gap (expected ${nextSeq}, got ${wire.seq}) — events were lost in transit; resync via entries()`,
                );
              }
              nextSeq = wire.seq + 1;
              yield wire.event;
            }
          } catch (error) {
            if (abort.signal.aborted) {
              if (watchdog.stale()) {
                throw new Error(
                  `control events: no bytes for ${SSE_IDLE_LIMIT_MS / 1000}s (heartbeats absent) — dead connection; resync via entries()`,
                );
              }
              return; // the consumer walked away — clean end, not an error
            }
            throw error;
          } finally {
            watchdog.stop();
          }
        })();
      return {
        [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
          const abort = new AbortController();
          // Abort-first cancellation (see abortFirstIterator): aborting the connection unblocks a
          // generator suspended on a quiet stream read.
          return abortFirstIterator(openStream(abort), () => abort.abort());
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
export function connectAgent(options: RemoteEndpointOptions): Agent {
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
  // Same guard for Scope: the body carries session only — a new Scope field must force a decision.
  const _scopeDriftGuard: Record<Exclude<keyof Scope, "session">, never> = {};
  void _scopeDriftGuard;
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
          // Armed BEFORE the fetch — the run's driver must not hang on a black-holed connect
          // either (the connect await is a pending read; headers arriving disarm it).
          const watchdog = idleWatchdog(abort);
          watchdog.arm();
          try {
            const res = await fetchFn(`${base}/control/invoke`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ session: scope.session, text: prompt.text }),
              signal: abort.signal,
            });
            watchdog.disarm(); // headers arrived
            if (!res.ok) {
              watchdog.arm(); // the error body is a pending read too — see the events() twin
              const failure = toFailed(new ControlRequestError(res.status, await res.text()));
              watchdog.disarm();
              yield failure;
              return;
            }
            if (!res.body) {
              yield { type: "failed", details: "remote invoke: response has no body", retryable: true };
              return;
            }
            for await (const data of sseData(res.body, watchdog)) {
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
              // Shape check, same discipline as the events plane: `data: null` / `data: 42` is
              // valid JSON but protocol drift — it must not TypeError into the catch below and be
              // misclassified as retryable network trouble.
              if (typeof event !== "object" || event === null || typeof event.type !== "string") {
                if (!terminalSeen) {
                  yield {
                    type: "failed",
                    details: "remote invoke: non-event data on the stream — protocol mismatch?",
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
            if (abort.signal.aborted) {
              if (watchdog.stale() && !terminalSeen) {
                yield {
                  type: "failed",
                  details: `remote invoke: no bytes for ${SSE_IDLE_LIMIT_MS / 1000}s (heartbeats absent) — dead connection`,
                  retryable: true,
                };
              }
              return; // the consumer walked away — cancellation, not an error
            }
            if (!terminalSeen) yield toFailed(error);
          } finally {
            watchdog.stop();
          }
        })();
      // ONE stream per invoke, like a local async generator (which is its own iterator): a second
      // iteration must never re-POST — that would silently start a second run with the same prompt.
      // Abort-first cancellation (see abortFirstIterator): disconnect = cancel the run, even
      // while suspended on a quiet read.
      const iterator = abortFirstIterator(openStream(), () => abort.abort());
      return {
        [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          return iterator;
        },
      };
    },
  };
}

/** Minimal SSE reader: yields each `data:` payload; ignores comments (heartbeats) and other
 *  fields. The explicit reader loop (not for-await) exists for the watchdog: armed strictly
 *  around each pending read, so only "we are listening and nothing arrives" counts as idle — a
 *  consumer pausing at a yield leaves the watch disarmed (see {@link ReadWatch}). */
async function* sseData(body: ReadableStream<Uint8Array>, watch?: ReadWatch): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      watch?.arm(); // a read is pending — the idle clock may run
      const { done, value } = await reader.read();
      watch?.disarm(); // bytes (ANY bytes — heartbeats included) or a clean end arrived
      if (done) return;
      // SSE permits CRLF line endings (proxies/other servers may produce them); normalize AFTER
      // appending so a \r\n split across chunks still collapses once its second half arrives.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
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
  } finally {
    reader.releaseLock();
  }
}
