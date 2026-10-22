/**
 * The Agent API's HTTP client (docs/design/agent-api.md §10): a remote `Agent`, failure rules included. A failure is a
 * value; only `getMessage` and `attachment` reject. A reply that may not have reached the Caller is never reported as a
 * refusal: an invoke or an abort whose answer did not arrive is `unknown`, a stream that stops is `serving_error`.
 * Imports no harness.
 */
import {
  type AbortResult,
  type Agent,
  type AgentError,
  type AgentInfo,
  AgentRejection,
  type CreateSessionResult,
  type InvokeRequest,
  type InvokeResult,
  type MessageStatus,
  type ReadResult,
  type Receipt,
  type ResumeEvent,
  type WaitResult,
  agentError,
} from "./agent-api.ts";
import {
  PAYLOAD_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  StreamEnded,
  abortFirstIterator,
  endedBecause,
  openStreamBody,
  readBudget,
  sseData,
  toBase64,
} from "./sse-client.ts";

export interface RemoteAgentApiOptions {
  /** Base URL of the serving process. It authenticates nobody: point this at whatever fronts it. */
  url: string;
  /** The transport seam: wrap `fetch` to add a gateway credential, or fake the network in a test. */
  fetchFn?: typeof fetch;
}

type Unknown = { ok: false; unknown: { reason: string; sessionId?: string; messageId?: string } };

const unreachable = (error: unknown): AgentError =>
  agentError(
    "unavailable",
    `the agent could not be reached: ${error instanceof Error ? error.message : String(error)}`,
  );

/** A request that never reached a server: the connection was not made, so nothing was recorded. */
function neverSent(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
}

/**
 * A reply's body as this API's: a value, an `error` it answered with, or the `unknown` it said. `foreign` is a reply
 * that is not the API's (a gateway's page), and `lost` a body the connection dropped: neither says what the Agent did.
 */
type Reply<T> =
  | { value: T }
  | { error: AgentError }
  | { unknown: Unknown["unknown"] }
  | { foreign: string }
  | { lost: unknown };

async function replyOf<T>(res: Response): Promise<Reply<T>> {
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    return { lost: error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { foreign: `${res.status} ${text.trim().slice(0, 200)}` };
  }
  if (res.ok) return { value: parsed as T };
  const body = parsed as { error?: AgentError; unknown?: Unknown["unknown"] } | null;
  if (typeof body?.error?.code === "string" && typeof body.error.message === "string") return { error: body.error };
  if (typeof body?.unknown?.reason === "string") return { unknown: body.unknown };
  return { foreign: `${res.status} ${text.trim().slice(0, 200)}` };
}

/** What a reply that is not a value means to a Caller that must not mistake it for a refusal. */
function notAnswered(reply: Exclude<Reply<unknown>, { value: unknown }>, known: { sessionId?: string }): Unknown {
  if ("unknown" in reply) return { ok: false, unknown: reply.unknown };
  const reason =
    "lost" in reply ? `the connection was lost: ${String(reply.lost)}` : "foreign" in reply ? reply.foreign : "";
  return { ok: false, unknown: { reason, ...known } };
}

/** Connects once to read `info()`, which the client then answers without a request. */
export async function connectAgentApi(options: RemoteAgentApiOptions): Promise<Agent> {
  const { fetchFn = fetch } = options;
  const base = options.url.replace(/\/$/, "");

  const send = (path: string, init: RequestInit = {}, signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(PAYLOAD_TIMEOUT_MS);
    return fetchFn(`${base}${path}`, {
      ...init,
      ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" } }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
  };
  const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
  const sessionPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;

  /** A call whose failure is a value, with nothing to be unsure about: a lost reply is `unavailable`. */
  const result = async <T extends object>(
    path: string,
    init?: RequestInit,
  ): Promise<({ ok: true } & T) | { ok: false; error: AgentError }> => {
    let res: Response;
    try {
      res = await send(path, init);
    } catch (error) {
      return { ok: false, error: unreachable(error) };
    }
    const reply = await replyOf<T>(res);
    if ("value" in reply) return { ok: true, ...reply.value };
    if ("error" in reply) return { ok: false, error: reply.error };
    if ("lost" in reply) return { ok: false, error: unreachable(reply.lost) };
    const status = res.status;
    const code = status === 502 || status === 503 || status === 504 ? "unavailable" : "internal";
    return { ok: false, error: agentError(code, "foreign" in reply ? reply.foreign : String(status)) };
  };

  /** A read with no failure branch: it rejects with the API's error, or `unavailable`. */
  const reading = async <T>(path: string, parse: (res: Response) => Promise<T>): Promise<T> => {
    let res: Response;
    try {
      res = await send(path);
    } catch (error) {
      throw new AgentRejection(unreachable(error), { cause: error });
    }
    return parse(res);
  };
  const jsonOf = async <T>(res: Response): Promise<T> => {
    const reply = await replyOf<T>(res);
    if ("value" in reply) return reply.value;
    if ("error" in reply) throw new AgentRejection(reply.error);
    if ("lost" in reply) throw new AgentRejection(unreachable(reply.lost), { cause: reply.lost });
    const code = res.status === 502 || res.status === 503 || res.status === 504 ? "unavailable" : "internal";
    throw new AgentRejection(agentError(code, "foreign" in reply ? reply.foreign : `${res.status}`));
  };

  const info = await reading("/agent", (res) => jsonOf<AgentInfo>(res));

  const getMessage: Agent["getMessage"] = (sessionId, key) =>
    reading(
      "messageId" in key
        ? `${sessionPath(sessionId)}/messages/${encodeURIComponent(key.messageId)}`
        : `${sessionPath(sessionId)}/messages?${new URLSearchParams({ idempotencyKey: key.idempotencyKey })}`,
      async (res) => (await jsonOf<MessageStatus | null>(res)) ?? undefined,
    );

  /**
   * A resume over SSE. Refused before it started, it is that one `rejected`; a stream that stops afterwards ends with a
   * `serving_error`, since a resume never ends on its own. The client does not reconnect: its Caller resumes after the
   * last entry it had (§5.1).
   */
  const resume: Agent["resume"] = (sessionId, resumeOptions = {}) => {
    const { replayFrom } = resumeOptions;
    const query =
      replayFrom === undefined
        ? ""
        : replayFrom.type === "start"
          ? "?replay=start"
          : `?${new URLSearchParams({ after: replayFrom.entryId })}`;
    const path = `${sessionPath(sessionId)}/events${query}`;
    const abort = new AbortController();
    const lost = (why: string): ResumeEvent => ({
      type: "serving_error",
      error: agentError("unavailable", `${path}: ${why}`),
    });
    const generate = async function* (): AsyncGenerator<ResumeEvent> {
      const budget = readBudget(abort, path, REQUEST_TIMEOUT_MS);
      let started = false;
      try {
        const body = await openStreamBody({
          fetchFn,
          url: `${base}${path}`,
          init: {},
          abort,
          budget,
          what: path,
          refused: async (res) => {
            const reply = await replyOf(res);
            return new Refused(
              "error" in reply ? reply.error : unreachable("foreign" in reply ? reply.foreign : res.status),
            );
          },
        });
        started = true;
        for await (const data of sseData(body, budget)) {
          let event: ResumeEvent;
          try {
            event = JSON.parse(data) as ResumeEvent;
          } catch {
            yield { type: "serving_error", error: agentError("internal", `${path}: data that is not JSON`) };
            return;
          }
          yield event;
          if (event.type === "serving_error" || event.type === "rejected") return;
        }
        yield lost("the stream was cut off");
      } catch (error) {
        const ended = endedBecause(abort.signal);
        if (ended?.kind === "cancelled") return;
        if (error instanceof Refused) yield { type: "rejected", error: error.error };
        else if (!started) yield { type: "rejected", error: unreachable(ended ?? error) };
        else yield lost(`the connection was lost: ${String(ended ?? error)}`);
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

  /** A message's end, read as §10 says: a `done` is never replayed, so one that came before the snapshot is asked. */
  const wait = async (receipt: Receipt, signal: AbortSignal | undefined): Promise<WaitResult> => {
    const { sessionId, message } = receipt;
    if (message.status === "done") return { ok: true, message };
    const unfinished = (reason: string): WaitResult => ({
      ok: false,
      unfinished: { reason: signal?.aborted ? "The wait was aborted" : reason },
    });
    if (signal?.aborted) return unfinished("");
    const events = resume(sessionId)[Symbol.asyncIterator]();
    const leave = () => void events.return?.();
    signal?.addEventListener("abort", leave, { once: true });
    try {
      for (let next = await events.next(); !next.done; next = await events.next()) {
        const event = next.value;
        if (event.type === "rejected" || event.type === "serving_error") return unfinished(event.error.message);
        if (event.type === "done" && event.message.messageId === message.messageId)
          return { ok: true, message: event.message };
        if (event.type === "state") {
          let now: MessageStatus | undefined;
          try {
            now = await getMessage(sessionId, { messageId: message.messageId });
          } catch (error) {
            return unfinished(error instanceof Error ? error.message : String(error));
          }
          if (now?.status === "done") return { ok: true, message: now };
        }
      }
      return unfinished("the session's events ended before the message did");
    } finally {
      signal?.removeEventListener("abort", leave);
      await events.return?.();
    }
  };

  /**
   * The receipt, or what its absence means. A request that never connected recorded nothing; any other failure before
   * the receipt arrived may have been accepted (§10), and the API's own `unknown` is kept with its ids.
   */
  const invoke = async (request: InvokeRequest): Promise<InvokeResult> => {
    const known = request.sessionId === undefined ? {} : { sessionId: request.sessionId };
    let res: Response;
    try {
      res = await send("/invoke", post(request));
    } catch (error) {
      if (neverSent(error)) return { ok: false, error: unreachable(error) };
      return { ok: false, unknown: { reason: `the connection failed before the receipt: ${String(error)}`, ...known } };
    }
    const reply = await replyOf<Receipt>(res);
    if ("error" in reply) return { ok: false, error: reply.error };
    if (!("value" in reply)) return notAnswered(reply, known);
    const receipt = reply.value;
    return { ok: true, ...receipt, wait: (waitOptions) => wait(receipt, waitOptions?.signal) };
  };

  /** An abort waits for the messages it stops (§5); one whose answer did not arrive is `unknown`, never a refusal. */
  const abort: Agent["abort"] = async (sessionId, abortOptions = {}) => {
    let res: Response;
    try {
      res = await send(`${sessionPath(sessionId)}/abort`, post({}), abortOptions.signal);
    } catch (error) {
      if (neverSent(error)) return { ok: false, error: unreachable(error) };
      const reason = abortOptions.signal?.aborted
        ? "The abort was aborted"
        : `the answer did not arrive: ${String(error)}`;
      return { ok: false, unknown: { reason } };
    }
    const reply = await replyOf<Extract<AbortResult, { ok: true }>>(res);
    if ("value" in reply) return { ok: true, stopped: reply.value.stopped };
    if ("error" in reply) return { ok: false, error: reply.error };
    const { unknown } = notAnswered(reply, {});
    return { ok: false, unknown: { reason: unknown.reason } };
  };

  return {
    info: () => info,
    invoke,
    getMessage,
    createSession: (createOptions = {}) =>
      result<Extract<CreateSessionResult, { ok: true }>>("/sessions", post(createOptions)),
    configure: (sessionId, settings) =>
      result<object>(sessionPath(sessionId), { method: "PATCH", body: JSON.stringify(settings) }),
    read: (sessionId, readOptions = {}) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(readOptions)) if (value !== undefined) query.set(key, String(value));
      const search = query.toString();
      return result<Extract<ReadResult, { ok: true }>>(`${sessionPath(sessionId)}${search === "" ? "" : `?${search}`}`);
    },
    resume,
    abort,
    attachment: (sessionId, ref) =>
      reading(`${sessionPath(sessionId)}/attachments/${encodeURIComponent(ref)}`, async (res) => {
        if (res.status === 404) return undefined;
        if (!res.ok) return jsonOf<never>(res);
        let bytes: ArrayBuffer;
        try {
          bytes = await res.arrayBuffer();
        } catch (error) {
          throw new AgentRejection(unreachable(error), { cause: error });
        }
        // The type as the sender declared it; `content-type` is the safe one the server serves the bytes under.
        const declared = res.headers.get("x-mime-type");
        return {
          mimeType:
            declared === null
              ? (res.headers.get("content-type") ?? "application/octet-stream")
              : decodeURIComponent(declared),
          data: toBase64(new Uint8Array(bytes)),
        };
      }),
  };
}

/** A non-2xx reply to a resume, before it started. */
class Refused extends Error {
  readonly error: AgentError;
  constructor(error: AgentError) {
    super(error.message);
    this.error = error;
  }
}
