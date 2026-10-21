/** The Agent API's Fetch client: receipts are finite requests, observation is a separate resumable SSE connection. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type Agent,
  type AgentError,
  type AgentInfo,
  AgentRejection,
  type AbortResult,
  type CreateSessionResult,
  type InvokeResult,
  type MessageStatus,
  type ReadResult,
  type Receipt,
  type ResumeEvent,
  agentError,
} from "./agent-api.ts";
import {
  AbortBody,
  InfoBody,
  MessageBody,
  ReadBody,
  ReceiptBody,
  RejectionBody,
  SessionBody,
  UnknownBody,
  decodeEvent,
  decodeWire,
} from "./agent-api-wire.ts";
import { portError, portRequest } from "./effect-port.ts";
import {
  PAYLOAD_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  abortFirstIterator,
  openStreamBody,
  readBudget,
  sseData,
  toBase64,
} from "./sse-client.ts";
import { waitForMessage } from "./agent-api-stream.ts";

export interface RemoteAgentApiOptions {
  url: string;
  fetchFn?: typeof fetch;
}
const unavailable = (error: unknown) =>
  agentError("unavailable", `The agent could not be read: ${error instanceof Error ? error.message : String(error)}`);

/** Connect once to obtain the information `info()` returns synchronously thereafter. */
export async function connectAgentApi({ url, fetchFn = fetch }: RemoteAgentApiOptions): Promise<Agent> {
  const base = url.replace(/\/$/, "");
  const pathOf = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;
  const request = <T>(path: string, init: RequestInit, parse: (response: Response) => Promise<T>) =>
    Effect.runPromise(
      portRequest(async (signal) => {
        const response = await fetchFn(`${base}${path}`, {
          ...init,
          signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
        });
        return parse(response);
      }, PAYLOAD_TIMEOUT_MS).pipe(
        Effect.matchCause({
          onFailure: (cause) => ({ error: unavailable(portError(cause)) }),
          onSuccess: (value) => ({ value }),
        }),
      ),
    );
  const post = (value: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  const jsonRequest = (path: string, init: RequestInit = {}) =>
    request(path, init, async (response) => ({ response, body: (await response.json()) as unknown }));

  const infoReply = await jsonRequest("/agent");
  if ("error" in infoReply) throw new AgentRejection(infoReply.error);
  if (!infoReply.value.response.ok)
    throw new AgentRejection(decodeWire<{ error: AgentError }>(RejectionBody, infoReply.value.body).error);
  const info = decodeWire<AgentInfo>(InfoBody, infoReply.value.body);

  const result = async <T>(
    path: string,
    schema: Schema.Top,
    init: RequestInit = {},
  ): Promise<({ ok: true } & T) | { ok: false; error: AgentError }> => {
    const reply = await jsonRequest(path, init);
    if ("error" in reply) return { ok: false, error: reply.error };
    try {
      const { response, body } = reply.value;
      return response.ok
        ? { ...decodeWire<T>(schema, body), ok: true }
        : { ok: false, ...decodeWire<{ error: AgentError }>(RejectionBody, body) };
    } catch (error) {
      // The response boundary includes malformed JSON shapes from a gateway or an incompatible server.
      return { ok: false, error: unavailable(error) };
    }
  };

  const resume: Agent["resume"] = (sessionId, options) => ({
    [Symbol.asyncIterator]() {
      const abort = new AbortController();
      const budget = readBudget(abort, "Resuming the agent", REQUEST_TIMEOUT_MS);
      const replay = options?.replayFrom;
      const query =
        replay?.type === "start"
          ? "?replay=start"
          : replay?.type === "after"
            ? `?after=${encodeURIComponent(replay.entryId)}`
            : "";
      const gen = (async function* (): AsyncGenerator<ResumeEvent> {
        try {
          const body = await openStreamBody({
            fetchFn,
            url: `${base}${pathOf(sessionId)}/events${query}`,
            init: {},
            abort,
            budget,
            refused: async (response) =>
              new AgentRejection(decodeWire<{ error: AgentError }>(RejectionBody, await response.json()).error),
            what: "Resuming the agent",
          });
          for await (const payload of sseData(body, budget)) {
            const event = decodeEvent(JSON.parse(payload));
            yield event;
            if (event.type === "serving_error" || event.type === "rejected") return;
          }
          yield {
            type: "serving_error",
            error: agentError("unavailable", "The session stream ended before detaching"),
          };
        } catch (error) {
          // HTTP refusals precede attachment; transport and decoding failures end observation, never the message.
          yield error instanceof AgentRejection
            ? {
                type: "rejected",
                error: {
                  code: error.code,
                  message: error.message,
                  retryable: error.retryable,
                  ...(error.details === undefined ? {} : { details: error.details }),
                },
              }
            : { type: "serving_error", error: unavailable(error) };
        } finally {
          budget.disarm();
          abort.abort();
        }
      })();
      return abortFirstIterator(gen, () => abort.abort());
    },
  });

  const agent: Agent = {
    info: () => info,
    async invoke(input): Promise<InvokeResult> {
      const reply = await jsonRequest("/invoke", post(input));
      const unknown = (reason: string): InvokeResult => ({
        ok: false,
        unknown: { reason, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) },
      });
      if ("error" in reply) return unknown(reply.error.message);
      try {
        const { response, body } = reply.value;
        if (response.status === 202) {
          const receipt = decodeWire<Receipt>(ReceiptBody, body);
          return { ...receipt, ok: true, wait: (options) => waitForMessage(agent, receipt, options) };
        }
        if (response.status === 503 && Schema.is(UnknownBody)(body)) {
          const parsed = decodeWire<Extract<InvokeResult, { unknown: unknown }>>(UnknownBody, body);
          return {
            ok: false,
            unknown: { ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), ...parsed.unknown },
          };
        }
        if (!response.ok) return { ok: false, ...decodeWire<{ error: AgentError }>(RejectionBody, body) };
        return unknown(`Unexpected invoke status ${response.status}`);
      } catch (error) {
        // No usable receipt or explicit refusal was obtained; the message may already be durable.
        return unknown(unavailable(error).message);
      }
    },
    async createSession(options): Promise<CreateSessionResult> {
      return result("/sessions", SessionBody, post(options ?? {}));
    },
    async read(sessionId, options): Promise<ReadResult> {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(options ?? {})) if (value !== undefined) query.set(key, String(value));
      return result(`${pathOf(sessionId)}?${query}`, ReadBody);
    },
    async getMessage(sessionId, key) {
      const suffix =
        "messageId" in key
          ? `/${encodeURIComponent(key.messageId)}`
          : `?idempotencyKey=${encodeURIComponent(key.idempotencyKey)}`;
      const reply = await jsonRequest(`${pathOf(sessionId)}/messages${suffix}`);
      if ("error" in reply) throw new AgentRejection(reply.error);
      try {
        const { response, body } = reply.value;
        if (!response.ok) throw new AgentRejection(decodeWire<{ error: AgentError }>(RejectionBody, body).error);
        return body === null ? undefined : decodeWire<MessageStatus>(MessageBody, body);
      } catch (error) {
        throw error instanceof AgentRejection ? error : new AgentRejection(unavailable(error));
      }
    },
    resume,
    async abort(sessionId, options): Promise<AbortResult> {
      const reply = await jsonRequest(`${pathOf(sessionId)}/abort`, {
        ...post({}),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if ("error" in reply) return { ok: false, unknown: { reason: reply.error.message } };
      try {
        const { response, body } = reply.value;
        if (response.ok)
          return { ok: true, ...decodeWire<{ stopped: { taken: string[]; queued: string[] } }>(AbortBody, body) };
        if (response.status === 503 && Schema.is(UnknownBody)(body))
          return { ok: false, ...decodeWire<{ unknown: { reason: string } }>(UnknownBody, body) };
        return { ok: false, ...decodeWire<{ error: AgentError }>(RejectionBody, body) };
      } catch (error) {
        return { ok: false, unknown: { reason: unavailable(error).message } };
      }
    },
    async attachment(sessionId, ref) {
      const reply = await request(
        `${pathOf(sessionId)}/attachments/${encodeURIComponent(ref)}`,
        {},
        async (response) => {
          if (response.status === 404) return undefined;
          if (!response.ok)
            throw new AgentRejection(decodeWire<{ error: AgentError }>(RejectionBody, await response.json()).error);
          return {
            mimeType:
              response.headers.get("x-mime-type") ?? response.headers.get("content-type") ?? "application/octet-stream",
            data: toBase64(new Uint8Array(await response.arrayBuffer())),
          };
        },
      );
      if ("error" in reply) throw new AgentRejection(reply.error);
      return reply.value;
    },
  };
  return agent;
}
