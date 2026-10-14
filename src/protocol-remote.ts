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

/** A reply the server refused, with the error it gave. */
class Refused extends Error {
  readonly error: AgentError;
  constructor(error: AgentError) {
    super(error.message);
    this.error = error;
  }
}

const unreachable = (error: unknown): AgentError =>
  agentError(
    "unavailable",
    `the agent could not be reached: ${error instanceof Error ? error.message : String(error)}`,
  );

/** The error a non-2xx reply carries, or one that says the reply was not this protocol's. */
async function refusalOf(res: Response): Promise<AgentError> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: AgentError };
    if (typeof parsed.error?.code === "string" && typeof parsed.error.message === "string") return parsed.error;
  } catch {
    // A body that is not JSON is answered below, with its status.
  }
  return agentError(res.status === 503 ? "unavailable" : "internal", `${res.status} ${body.trim()}`);
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
    if (!res.ok) return { ok: false, error: await refusalOf(res) };
    return (await res.json()) as T;
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
    if (!res.ok) throw new AgentRejection(await refusalOf(res));
    return (await res.json()) as T;
  };

  /**
   * An event stream. Refused before it started, it is that one `rejected`; a connection lost after it started ends it
   * with a `serving_error`, after which a caller reattaches from its last entry.
   */
  const events = <T extends FollowEvent | InvokeEvent>(
    path: string,
    init: RequestInit,
    connectMs: number,
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
          yield event;
        }
      } catch (error) {
        const ended = endedBecause(abort.signal);
        if (ended?.kind === "cancelled") return;
        if (error instanceof Refused) yield { type: "rejected", error: error.error } as T;
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

  const info = await (async (): Promise<AgentInfo> => {
    const res = await request("/agent");
    if (!res.ok) throw new AgentRejection(await refusalOf(res));
    return (await res.json()) as AgentInfo;
  })();

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
      follow: (options = {}) =>
        addressable ? events<FollowEvent>(`${path}/follow${query(options)}`, {}, REQUEST_TIMEOUT_MS) : rejectedStream(),
      attachment: async (ref) => {
        if (!addressable) return undefined;
        return reading(`${path}/attachments/${encodeURIComponent(ref)}`, async (res) => {
          if (res.status === 404) return undefined;
          if (!res.ok) throw new AgentRejection(await refusalOf(res));
          return {
            mimeType: res.headers.get("content-type") ?? "application/octet-stream",
            data: toBase64(new Uint8Array(await res.arrayBuffer())),
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
              )
            : rejectedStream(),
        cancel: async (runId) =>
          addressable
            ? result<{ ok: true }>(`${path}/runs/${encodeURIComponent(runId)}/cancel`, post())
            : unaddressable,
      },
    };
  };

  return {
    // The connect limit is the payload one: a scale-to-zero host may hold this open while a machine boots.
    invoke: (invokeRequest: InvokeRequest) =>
      events<InvokeEvent>(
        "/invoke",
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(invokeRequest),
        },
        PAYLOAD_TIMEOUT_MS,
      ),
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
