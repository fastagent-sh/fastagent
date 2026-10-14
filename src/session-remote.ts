/** The remote `SessionControl` — the client half of the HTTP + SSE transport (docs/design/session-control.md §13). */
import type { Agent, AgentEvent, Prompt, Scope } from "./agent.ts";
import {
  PAYLOAD_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  StreamEnded,
  endedBecause,
  openStreamBody,
  readBudget,
  sseData,
  toBase64,
} from "./sse-client.ts";
import { abortFirstIterator } from "./collect.ts";
import type { WireEvent } from "./channels/control.ts";
import {
  isAddressableSession,
  type AgentCommand,
  type Session,
  type ModelDescriptor,
  type SessionCapabilities,
  type SessionEntries,
  type SessionEvent,
  type SessionEventStream,
  type SessionControl,
  type SessionResult,
  type SessionState,
  type SessionSummary,
} from "./session.ts";

/** A control request the server answered with a non-2xx status. */
export class ControlRequestError extends Error {
  readonly status: number;
  /**
   * The plane's own error code, when the reply carried one (`sessions()` is the only read that does today — design
   * §13).
   */
  readonly code?: string;
  /**
   * Whether re-sending is worth it, as the plane itself answered — the same question `SessionResult.retryable`
   * answers for a write, carried here because a throwing read has no result to put it in. Absent when the reply
   * declared no opinion; a caller then has only the status.
   */
  readonly retryable?: boolean;
  constructor(status: number, body: string, declared?: { code?: string; retryable?: boolean }) {
    super(`control request failed: ${status} ${body}`);
    this.status = status;
    if (declared?.code !== undefined) this.code = declared.code;
    if (declared?.retryable !== undefined) this.retryable = declared.retryable;
  }
}

/** A non-2xx reply as an error, carrying what the plane declared about it. */
async function controlError(res: Response): Promise<ControlRequestError> {
  const body = await res.text();
  if (!res.headers.get("content-type")?.includes("application/json")) return new ControlRequestError(res.status, body);
  let parsed: { code?: unknown; retryable?: unknown } | null;
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    // The reply declared JSON and is not — a protocol fault worth seeing, but not worth losing the status over.
    return new ControlRequestError(res.status, `${body} (declared application/json but did not parse)`);
  }
  return new ControlRequestError(res.status, body, {
    ...(typeof parsed?.code === "string" ? { code: parsed.code } : {}),
    ...(typeof parsed?.retryable === "boolean" ? { retryable: parsed.retryable } : {}),
  });
}

/**
 * Connection parameters shared by BOTH remote planes (`connectSessionControl` and `connectAgent`) — plane-neutral on
 * purpose: one endpoint, two contracts.
 */
export interface RemoteEndpointOptions {
  /**
   * Base URL of the serving process (e.g. `http://127.0.0.1:8787`). fastagent serves it unauthenticated — point this
   * at whatever fronts it (a gateway, an SSH tunnel, a private network address), not at a public port.
   */
  url: string;
  /**
   * The transport seam. fastagent authenticates nothing, so whatever fronts the serve is what a caller has to
   * satisfy: wrap `fetch` here to add a gateway credential, refresh it, sign the request, or pin a client
   * certificate — a static header cannot express the refresh an IdP proxy needs. Tests inject a fake through the
   * same seam.
   */
  fetchFn?: typeof fetch;
}

export async function connectSessionControl(options: RemoteEndpointOptions): Promise<SessionControl> {
  const { url, fetchFn = fetch } = options;
  const base = url.replace(/\/$/, "");

  const get = async <T>(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> => {
    const res = await fetchFn(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw await controlError(res);
    return (await res.json()) as T;
  };

  const capabilities = await get<SessionCapabilities>("/control/capabilities");
  const eventsOf = (session: string): SessionEventStream => {
    // The server subscribes BEFORE it writes the response headers (channels/sse.ts pulls the source once first), so
    // "headers arrived, 2xx" IS "this session's subscription exists" — the boundary a reconnecting client awaits
    // before reading history (session.ts, SessionEventStream).
    let subscribed!: () => void;
    let unreachable!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      subscribed = resolve;
      unreachable = reject;
    });
    // A consumer that never awaits `ready` (it can iterate and let the stream report the same failure) would
    // otherwise take an unhandled rejection for a connection that legitimately failed. Awaiters still get it.
    ready.catch(() => {});
    // ONE CALL IS ONE SUBSCRIPTION — one connection, one readiness. A second iteration would open a second
    // connection and inherit this `ready`, reporting a boundary the first one crossed; it is refused instead, the
    // same way the local hub refuses it.
    const openStream = (abort: AbortController) =>
      (async function* iterate(): AsyncGenerator<SessionEvent> {
        const budget = readBudget(abort, "control events", REQUEST_TIMEOUT_MS);
        try {
          let body: ReadableStream<Uint8Array>;
          try {
            body = await openStreamBody({
              fetchFn,
              url: `${base}/control/sessions/${encodeURIComponent(session)}/events`,
              init: {},
              abort,
              budget,
              what: "control events",
              refused: async (res) => new ControlRequestError(res.status, await res.text()),
            });
          } catch (error) {
            // The subscription was never established: the endpoint is unreachable or never completed a response, a
            // gateway in front refused it, the consumer cancelled first. Whoever ended it said why, and `fetch` rejected with
            // that very object. A waiter on `ready` must learn it instead of waiting out a stream that will never
            // carry anything — including the cancellation, which the ITERATION reports as a clean end (walking away
            // is not an error) while `ready` still has a promise it cannot keep.
            const failure = endedBecause(abort.signal) ?? error;
            unreachable(failure);
            throw failure;
          }
          subscribed();
          let nextSeq = 0;
          for await (const data of sseData(body, budget)) {
            // Parse discipline, same as the other two wire planes (dispatch parses, invoke classifies drift): a
            // non-JSON or non-envelope payload is PROTOCOL MISMATCH.
            let wire: WireEvent;
            try {
              // The ONE envelope type (control.ts's WireEvent) — an inline shape would let the envelope drift
              // server-side while this cast silently kept the old fields.
              wire = JSON.parse(data) as WireEvent;
            } catch (parseError) {
              throw new Error(
                `control events: non-JSON data on the stream (${String(parseError)}) — protocol mismatch?`,
              );
            }
            if (
              typeof wire !== "object" ||
              wire === null ||
              typeof wire.seq !== "number" ||
              typeof wire.event !== "object" ||
              wire.event === null ||
              typeof wire.event.type !== "string"
            ) {
              throw new Error("control events: malformed envelope — the endpoint does not speak this protocol version");
            }
            // Envelope checks — consumed HERE.
            if (wire.seq !== nextSeq) {
              throw new Error(
                `control events: sequence gap (expected ${nextSeq}, got ${wire.seq}) — events were lost in transit; resync via entries()`,
              );
            }
            nextSeq = wire.seq + 1;
            yield wire.event;
          }
        } catch (error) {
          const ended = endedBecause(abort.signal);
          if (ended?.kind === "cancelled") return; // the consumer walked away — clean end, not an error
          throw ended ?? error;
        } finally {
          budget.disarm();
          abort.abort();
        }
      })();
    let iterated = false;
    return {
      ready,
      [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        if (iterated) {
          throw new Error("control events: this stream is one subscription — call events() again for another");
        }
        iterated = true;
        const abort = new AbortController();
        // Abort-first cancellation (see abortFirstIterator): aborting the connection unblocks a generator suspended
        // on a quiet stream read.
        return abortFirstIterator(openStream(abort), () => {
          const cancelled = new StreamEnded("cancelled", "control events: cancelled by the consumer");
          abort.abort(cancelled);
          // Said HERE as well as in the generator's catch, because a generator that was never pulled does not run its
          // body on `return()` — and then nothing else would ever settle `ready`. Rejecting an already-settled
          // promise is a no-op, so the connected case still reports whatever ended it.
          unreachable(cancelled);
        });
      },
    };
  };

  /**
   * A write that answers a `SessionResult`: the result rides HTTP 200 either way (`ok: false` is a protocol answer,
   * not a transport failure), so a non-2xx here is a REAL transport fault.
   */
  const write = async (path: string, method: string, body?: unknown): Promise<SessionResult> => {
    // Always declared, body or not: the plane refuses a write it was not told is JSON (channels/body.ts), and an
    // empty `PATCH` is a legal no-op that still has to get through.
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(PAYLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw await controlError(res);
    return (await res.json()) as SessionResult;
  };

  const id = (session: string) => encodeURIComponent(session);

  return {
    capabilities: () => capabilities,

    // NOT prefetched like capabilities: a live definition can grow a skill between calls, so the list is fetched per
    // call.
    async commands() {
      try {
        return await get<AgentCommand[]>("/control/commands");
      } catch (error) {
        if (error instanceof ControlRequestError && error.status === 404) {
          throw new ControlRequestError(404, "this serve does not implement /control/commands (it predates the route)");
        }
        throw error;
      }
    },

    // NOT prefetched either, for the same reason: the definition can change which models it declares.
    models: () => get<ModelDescriptor[]>("/control/models"),

    sessions: {
      // Rejects when the deployment cannot enumerate its store.
      list: () => get<SessionSummary[]>("/control/sessions", PAYLOAD_TIMEOUT_MS),

      // PUT: the fork is idempotent, and so is the request that carries it.
      fork: async ({ from, at, into }: { from: string; at: string; into: string }) => {
        if (!isAddressableSession(into)) {
          throw new Error(
            `session id ${JSON.stringify(into)} cannot travel as a URL path segment — this transport cannot address it`,
          );
        }
        return write(`/control/sessions/${id(into)}`, "PUT", { from, at });
      },

      // The local hub's handle is a pure binding; so is this one — an id and the transport above it.
      get: (session: string): Session => {
        if (!isAddressableSession(session)) {
          throw new Error(
            `session id ${JSON.stringify(session)} cannot travel as a URL path segment — this transport cannot address it`,
          );
        }
        return {
          id: session,
          state: () => get<SessionState>(`/control/sessions/${id(session)}`),
          entries: (options) =>
            get<SessionEntries>(
              `/control/sessions/${id(session)}/entries${
                options?.since !== undefined ? `?since=${encodeURIComponent(options.since)}` : ""
              }`,
              PAYLOAD_TIMEOUT_MS, // the download-direction payload call — see the constant's note
            ),
          image: async (ref) => {
            const res = await fetchFn(`${base}/control/sessions/${id(session)}/image?ref=${encodeURIComponent(ref)}`, {
              signal: AbortSignal.timeout(PAYLOAD_TIMEOUT_MS),
            });
            if (!res.ok) throw await controlError(res);
            if (res.status === 204) return undefined;
            return {
              data: toBase64(new Uint8Array(await res.arrayBuffer())),
              mimeType: res.headers.get("content-type") ?? "application/octet-stream",
            };
          },
          events: () => eventsOf(session),
          update: (patch) => write(`/control/sessions/${id(session)}`, "PATCH", patch),
          steer: (prompt) => write(`/control/sessions/${id(session)}/actions`, "POST", { type: "steer", prompt }),
          followUp: (prompt) =>
            write(`/control/sessions/${id(session)}/actions`, "POST", { type: "follow_up", prompt }),
          abort: () => write(`/control/sessions/${id(session)}/actions`, "POST", { type: "abort" }),
          compact: (options) =>
            write(`/control/sessions/${id(session)}/actions`, "POST", {
              type: "compact",
              ...(options?.instructions !== undefined ? { instructions: options.instructions } : {}),
            }),
          delete: () => write(`/control/sessions/${id(session)}`, "DELETE"),
        };
      },
    },
  };
}

/**
 * The remote DATA plane: an `Agent` whose `invoke` drives `POST /invoke` on a serving process. A real Agent,
 * failure discipline included — SPEC MUST 2 forbids iteration throws, so transport, protocol and precheck failures
 * all become `failed` events.
 */
export function connectAgent(options: RemoteEndpointOptions): Agent {
  const { url, fetchFn = fetch } = options;
  const base = url.replace(/\/$/, "");
  const toFailed = (error: unknown): AgentEvent => {
    if (error instanceof ControlRequestError) {
      return { type: "failed", details: error.message, retryable: error.status === 429 || error.status >= 500 };
    }
    return { type: "failed", details: String(error), retryable: true }; // network-class: worth re-sending
  };
  // COMPILE-TIME drift guard (dispatch-wire parity): the invoke body carries exactly text (and rejects images
  // visibly).
  const _invokeDriftGuard: Record<Exclude<keyof Prompt, "text" | "images">, never> = {};
  void _invokeDriftGuard;
  // Same guard for Scope: the body carries session + the lineage extension — a new Scope field must force a decision
  // (carry it or reject it), never vanish on the wire.
  const _scopeDriftGuard: Record<Exclude<keyof Scope, "session" | "parentSession" | "branchHints">, never> = {};
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
          // A terminal closes the stream. Cleanup errors must not append a second terminal.
          let terminalSeen = false;
          // The run's driver rides the same mechanism as the events plane, with the connect limit its own callers
          // need: a black-holed POST must not hang it, but a scale-to-zero host (fly `auto_start_machines`, a cold
          // AgentCore container) can legitimately hold this open for tens of seconds before the first header, and
          // that is a slow success, not a dead endpoint. A connect failure lands in the catch below, which is where
          // every non-terminal failure becomes the one `failed` event this stream owes its caller.
          const budget = readBudget(abort, "remote invoke", PAYLOAD_TIMEOUT_MS);
          try {
            const body = await openStreamBody({
              fetchFn,
              url: `${base}/invoke`,
              init: {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  session: scope.session,
                  text: prompt.text,
                  // Lineage rides the wire so a remote thread scope inherits server-side; the server reads it on the
                  // session-create path only, same as in-process.
                  ...(scope.parentSession !== undefined ? { parentSession: scope.parentSession } : {}),
                  ...(scope.branchHints !== undefined ? { branchHints: scope.branchHints } : {}),
                }),
              },
              abort,
              budget,
              what: "remote invoke",
              refused: async (res) => new ControlRequestError(res.status, await res.text()),
            });
            for await (const data of sseData(body, budget)) {
              let event: AgentEvent;
              try {
                event = JSON.parse(data) as AgentEvent;
              } catch (parseError) {
                yield {
                  type: "failed",
                  details: `remote invoke: unparseable event on the stream (${String(parseError)})`,
                  retryable: false,
                };
                return;
              }
              // Shape check, same discipline as the events plane: `data: null` / `data: 42` is valid JSON but
              // protocol drift.
              if (typeof event !== "object" || event === null || typeof event.type !== "string") {
                yield {
                  type: "failed",
                  details: "remote invoke: non-event data on the stream — protocol mismatch?",
                  retryable: false,
                };
                return;
              }
              terminalSeen = event.type === "completed" || event.type === "failed";
              yield event;
              if (terminalSeen) return;
            }
            yield { type: "failed", details: "remote invoke: stream ended without a terminal", retryable: true };
          } catch (error) {
            const ended = endedBecause(abort.signal);
            // Cancellation is the consumer's own doing — reporting it back would be news to nobody. Any other stated
            // reason is a connection that died under the run, and this stream still owes its caller a terminal —
            // unless one was already sent, since a second would describe the run rather than the connection.
            if (ended?.kind === "cancelled") return;
            if (!terminalSeen)
              yield ended ? { type: "failed", details: ended.message, retryable: true } : toFailed(error);
          } finally {
            budget.disarm();
            abort.abort();
          }
        })();
      // ONE stream per invoke, like a local async generator (which is its own iterator): a second iteration must
      // never re-POST.
      const iterator = abortFirstIterator(openStream(), () =>
        abort.abort(new StreamEnded("cancelled", "remote invoke: cancelled by the consumer")),
      );
      return {
        [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          return iterator;
        },
      };
    },
  };
}
