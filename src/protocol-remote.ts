/**
 * The remote SPEC v1 `Agent`: the client half of `channels/protocol-http.ts`. A real Agent, failure rules included:
 * iterating never throws, a result that failed resolves as one, and only the reads with no failure branch reject
 * (SPEC v1 §2). A transport failure is `unavailable`, which a caller may retry.
 */
import { abortFirstIterator } from "./collect.ts";
import {
  type AbortResult,
  type AgentCommand,
  type Agent,
  type AgentError,
  type AgentInfo,
  AgentRejection,
  type FollowEvent,
  type InvokeEvent,
  type InvokeRequest,
  type ReadResult,
  type Result,
  type RunStatus,
  type Session,
  type SessionSummary,
  type ModelDescriptor,
  agentError,
  failure,
  isAddressable,
} from "./protocol.ts";
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

export interface RemoteAgentOptions {
  /** Base URL of the serving process. It authenticates nobody: point this at whatever fronts it. */
  url: string;
  /** The transport seam: wrap `fetch` to add a gateway credential, sign a request, or fake the network in a test. */
  fetchFn?: typeof fetch;
}

/** A non-2xx reply. `ours` when this protocol answered it, which says nothing ran; a gateway's page says nothing. */
class Refused extends Error {
  readonly error: AgentError;
  readonly ours: boolean;
  constructor(refusal: { error: AgentError; ours: boolean }) {
    super(refusal.error.message);
    this.error = refusal.error;
    this.ours = refusal.ours;
  }
}

/**
 * A 2xx reply's JSON. Its body can still fail: the connection lost while it is read (`unavailable`), or a reply that is
 * not this protocol's, such as a proxy's HTML page (`internal`).
 */
async function bodyOf<T>(res: Response): Promise<{ value: T } | { error: AgentError }> {
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    return { error: unreachable(error) };
  }
  try {
    return { value: JSON.parse(text) as T };
  } catch {
    return { error: agentError("internal", `a ${res.status} reply that is not JSON: ${text.slice(0, 200)}`) };
  }
}

/** Whether an event is `runId`'s `run_ended`. */
const endsRunOf =
  (runId: string) =>
  (event: FollowEvent | InvokeEvent): boolean =>
    event.type === "entry" && event.entry.kind === "run_ended" && event.entry.runId === runId;

/** An invoke ends on the `run_ended` of the run its receipt named. */
function receiptThenEnd(): (event: InvokeEvent) => boolean {
  let runId: string | undefined;
  return (event) => {
    if (event.type === "accepted") runId = event.run.runId;
    return runId !== undefined && endsRunOf(runId)(event);
  };
}

/** A request that never reached a server: the connection was not made, so nothing was recorded. */
function neverSent(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
}

const unreachable = (error: unknown): AgentError =>
  agentError(
    "unavailable",
    `the agent could not be reached: ${error instanceof Error ? error.message : String(error)}`,
  );

/** The error a non-2xx reply carries, and whether this protocol gave it. Reading the body may fail too. */
async function refusalOf(res: Response): Promise<{ error: AgentError; ours: boolean }> {
  let body: string;
  try {
    body = await res.text();
  } catch (error) {
    return { error: unreachable(error), ours: false };
  }
  try {
    const parsed = JSON.parse(body) as { error?: AgentError };
    if (typeof parsed.error?.code === "string" && typeof parsed.error.message === "string") {
      return { error: parsed.error, ours: true };
    }
  } catch {
    // Not this protocol's body: a gateway's page, answered below by its status.
  }
  const code = res.status === 502 || res.status === 503 || res.status === 504 ? "unavailable" : "internal";
  return { error: agentError(code, `${res.status} ${body.trim()}`), ours: false };
}

/** Connects once to read the agent's capabilities, which `info()` answers without a request. */
export async function connectRemoteAgent(options: RemoteAgentOptions): Promise<Agent> {
  const { fetchFn = fetch } = options;
  const base = options.url.replace(/\/$/, "");

  const request = (path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS) =>
    fetchFn(`${base}${path}`, {
      ...init,
      ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" } }),
      signal: AbortSignal.timeout(timeoutMs),
    });

  /** A call that answers with a result, which resolves either way. */
  const result = async <T extends { ok: true }>(
    path: string,
    init: RequestInit = {},
  ): Promise<T | { ok: false; error: AgentError }> => {
    let res: Response;
    try {
      res = await request(path, init, PAYLOAD_TIMEOUT_MS);
    } catch (error) {
      return { ok: false, error: unreachable(error) };
    }
    if (!res.ok) return { ok: false, error: (await refusalOf(res)).error };
    const body = await bodyOf<T>(res);
    return "value" in body ? body.value : { ok: false, error: body.error };
  };

  /** A read with no failure branch: it rejects with the server's `AgentRejection`, or `unavailable`. */
  const reading = async <T>(path: string, parse: (res: Response) => Promise<T>): Promise<T> => {
    let res: Response;
    try {
      res = await request(path, {}, PAYLOAD_TIMEOUT_MS);
    } catch (error) {
      throw new AgentRejection(unreachable(error), { cause: error });
    }
    return parse(res);
  };
  const jsonOf = async <T>(res: Response): Promise<T> => {
    if (!res.ok) throw new AgentRejection((await refusalOf(res)).error);
    const body = await bodyOf<T>(res);
    if ("error" in body) throw new AgentRejection(body.error);
    return body.value;
  };

  /**
   * An event stream. Refused before it started, it is that one `rejected`; a connection lost after it started ends it
   * with a `serving_error`, after which a caller reattaches from its last entry.
   */
  const events = <T extends FollowEvent | InvokeEvent>(
    path: string,
    init: RequestInit,
    connectMs: number,
    /**
     * Whether an event is the one the stream ends on. A stream that ends before it is cut off, by a proxy or a server
     * going down, and says so with a `serving_error`: a caller must not read a run that did not end as one that did.
     */
    ends: (event: T) => boolean,
    /** Said instead of `rejected` when the request may have reached the server before the connection failed. */
    unsure?: (reason: string) => AsyncIterable<T>,
  ): AsyncIterable<T> => {
    const abort = new AbortController();
    const generate = async function* (): AsyncGenerator<T> {
      const budget = readBudget(abort, path, connectMs);
      let started = false;
      try {
        const body = await openStreamBody({
          fetchFn,
          url: `${base}${path}`,
          init,
          abort,
          budget,
          what: path,
          refused: async (res) => new Refused(await refusalOf(res)),
        });
        started = true;
        for await (const data of sseData(body, budget)) {
          let event: T;
          try {
            event = JSON.parse(data) as T;
          } catch {
            yield { type: "serving_error", message: `${path}: data that is not JSON on the stream` } as T;
            return;
          }
          if (typeof event !== "object" || event === null || typeof event.type !== "string") {
            yield { type: "serving_error", message: `${path}: data that is not an event on the stream` } as T;
            return;
          }
          yield event;
          if (event.type === "rejected" || event.type === "serving_error" || ends(event)) return;
        }
        yield { type: "serving_error", message: `${path}: the stream was cut off before it ended` } as T;
      } catch (error) {
        const ended = endedBecause(abort.signal);
        if (ended?.kind === "cancelled") return;
        const sure = error instanceof Refused ? error.ours : neverSent(error);
        if (!started && unsure && !sure) yield* unsure(String(ended ?? error));
        else if (error instanceof Refused) yield { type: "rejected", error: error.error } as T;
        else if (!started) yield { type: "rejected", error: unreachable(ended ?? error) } as T;
        else
          yield { type: "serving_error", message: `${path}: the connection was lost: ${String(ended ?? error)}` } as T;
      } finally {
        budget.disarm();
        abort.abort();
      }
    };
    const iterator = abortFirstIterator(generate(), () =>
      abort.abort(new StreamEnded("cancelled", `${path}: cancelled by the consumer`)),
    );
    return { [Symbol.asyncIterator]: () => iterator };
  };

  // A scale-to-zero host is woken by this first request, so it gets the payload budget, not the black-hole one.
  const info = await reading("/agent", (res) => jsonOf<AgentInfo>(res));

  const query = (params: Record<string, string | number | undefined>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
    const text = search.toString();
    return text === "" ? "" : `?${text}`;
  };

  const session = (sessionId: string): Session => {
    const addressable = isAddressable(sessionId);
    const unaddressable = failure("invalid_request", `session id ${JSON.stringify(sessionId)} cannot be addressed`);
    const path = `/sessions/${encodeURIComponent(sessionId)}`;
    const post = (body: unknown = {}): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
    const rejectedStream = (): AsyncIterable<FollowEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "rejected", error: unaddressable.error };
      },
    });
    return {
      sessionId,
      read: async (options = {}) =>
        addressable ? result<Extract<ReadResult, { ok: true }>>(`${path}${query(options)}`) : unaddressable,
      // A follow never ends on its own: any end is a cut.
      follow: (options = {}) =>
        addressable
          ? events<FollowEvent>(`${path}/follow${query(options)}`, {}, REQUEST_TIMEOUT_MS, () => false)
          : rejectedStream(),
      attachment: async (ref) => {
        if (!addressable) return undefined;
        return reading(`${path}/attachments/${encodeURIComponent(ref)}`, async (res) => {
          if (res.status === 404) return undefined;
          if (!res.ok) throw new AgentRejection((await refusalOf(res)).error);
          let bytes: ArrayBuffer;
          try {
            bytes = await res.arrayBuffer();
          } catch (error) {
            throw new AgentRejection(unreachable(error), { cause: error });
          }
          return {
            // The type as the sender declared it; `content-type` is the safe one the server serves the bytes under.
            mimeType: res.headers.get("x-mime-type") ?? res.headers.get("content-type") ?? "application/octet-stream",
            data: toBase64(new Uint8Array(bytes)),
          };
        });
      },
      abort: async () =>
        addressable ? result<Extract<AbortResult, { ok: true }>>(`${path}/abort`, post()) : unaddressable,
      rewind: async (entryId) =>
        addressable ? result<{ ok: true }>(`${path}/rewind`, post({ entryId })) : unaddressable,
      compact: async (options = {}) =>
        addressable ? result<{ ok: true }>(`${path}/compact`, post(options)) : unaddressable,
      update: async (settings): Promise<Result> =>
        addressable
          ? result<{ ok: true }>(`/control${path}`, { method: "PATCH", body: JSON.stringify(settings) })
          : unaddressable,
      delete: async (): Promise<Result> =>
        addressable ? result<{ ok: true }>(`/control${path}`, { method: "DELETE" }) : unaddressable,
      runs: {
        get: async (key) => {
          if (!addressable) return undefined;
          const at =
            "runId" in key
              ? `${path}/runs/${encodeURIComponent(key.runId)}`
              : `${path}/runs${query({ idempotencyKey: key.idempotencyKey })}`;
          return reading(at, async (res) => (await jsonOf<RunStatus | null>(res)) ?? undefined);
        },
        follow: (runId, options = {}) =>
          addressable
            ? events<FollowEvent>(
                `${path}/runs/${encodeURIComponent(runId)}/events${query(options)}`,
                {},
                REQUEST_TIMEOUT_MS,
                (event) => endsRunOf(runId)(event),
              )
            : rejectedStream(),
        cancel: async (runId) =>
          addressable
            ? result<{ ok: true }>(`${path}/runs/${encodeURIComponent(runId)}/cancel`, post())
            : unaddressable,
      },
    };
  };

  /**
   * The connection failed before the receipt, so the run may have been accepted, or may yet be: the server can still be
   * reading the request. Sending it again with its key settles it, since the server answers a key it has seen with that
   * run and starts one for a key it has not. Without a key nothing can tell, and saying `rejected` would invite a
   * second run.
   */
  function settleUnsure(invokeRequest: InvokeRequest, reason: string): AsyncIterable<InvokeEvent> {
    const unknown = (why: string): AsyncIterable<InvokeEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "serving_error", message: `whether the run was accepted is unknown: ${why}` };
      },
    });
    if (invokeRequest.sessionId === undefined || invokeRequest.idempotencyKey === undefined) {
      return unknown(
        `the connection failed before the receipt (${reason}); send with an idempotencyKey to make sending again safe`,
      );
    }
    return invokeStream(invokeRequest, (again) =>
      unknown(`the connection failed before the receipt (${reason}), and again when it was sent again (${again})`),
    );
  }

  const invokeStream = (
    invokeRequest: InvokeRequest,
    unsure: (reason: string) => AsyncIterable<InvokeEvent>,
  ): AsyncIterable<InvokeEvent> =>
    events<InvokeEvent>(
      "/invoke",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(invokeRequest),
      },
      PAYLOAD_TIMEOUT_MS,
      receiptThenEnd(),
      unsure,
    );

  return {
    // The connect limit is the payload one: a scale-to-zero host may hold this open while a machine boots.
    invoke: (invokeRequest: InvokeRequest) =>
      invokeStream(invokeRequest, (reason) => settleUnsure(invokeRequest, reason)),
    sessions: {
      create: (options = {}) =>
        result<{ ok: true; sessionId: string }>("/sessions", { method: "POST", body: JSON.stringify(options) }),
      list: () => reading("/sessions", (res) => jsonOf<SessionSummary[]>(res)),
      get: session,
    },
    info: () => info,
    models: () => reading("/agent/models", (res) => jsonOf<ModelDescriptor[]>(res)),
    commands: () => reading("/agent/commands", (res) => jsonOf<AgentCommand[]>(res)),
  };
}
