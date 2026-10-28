/**
 * An Agent over HTTP (agent-api.md §8, §9): the interface `openAgent` gives in process, called through the contract the
 * server answers from. Runs wherever `fetch` does (Node, Bun, Deno, Workers): nothing here needs a runtime's own API.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import {
  type Agent,
  AgentError,
  CompactOptions,
  CreateSessionOptions,
  EntriesOptions,
  LIMITS,
  ListOptions,
  type Message,
  MessageKey,
  type MessageStreamEvent,
  type Page,
  SendRequest,
  type SessionEvent,
  SessionChanges,
  Wait,
  type WaitOptions,
  agentError,
  errorData,
  hasEnded,
} from "../agent-api.ts";
import { AgentHttpApi, MESSAGE_STREAM_EVENT_TYPES, Refusal, SESSION_EVENT_TYPES } from "./contract.ts";

export interface ConnectOptions {
  /** One of the keys the instance holds (`FASTAGENT_API_KEY` where it runs). */
  apiKey: string;
}

/**
 * What a request checks before it is sent, with the schema the in-process Agent checks it with. A field given as
 * `undefined` is left out (§4): JSON would send it as `null`, which in a session's changes clears the field.
 */
function checked<S extends Schema.Top>(schema: S, value: unknown, what: string): S["Type"] {
  const exit = Schema.decodeUnknownExit(schema as unknown as Schema.Codec<S["Type"], unknown>)(value);
  if (Exit.isSuccess(exit)) return present(exit.value);
  throw agentError("invalid_request", `${what}: ${String(Cause.squash(exit.cause))}`);
}

function present<T>(value: T): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) => (field === undefined ? [] : [[key, present(field)]])),
  ) as T;
}

const rejected = (signal: AbortSignal) =>
  Effect.callback<never, unknown>((resume) => {
    const onAbort = () => resume(Effect.fail(signal.reason));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

export function connectAgent(url: string, options: ConnectOptions): Agent {
  const baseUrl = url.replace(/\/+$/, "");
  const client = Effect.runSync(
    HttpApiClient.make(AgentHttpApi, {
      baseUrl,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(options.apiKey)),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ).agent;

  /**
   * A failure as the Agent API's. A refusal the agent answered is as it was sent. A request that went out and got no
   * answer this client can read is `lost`'s to say for a send, which may have been recorded (§5.2); for the rest, one
   * that could not get through or met a server's error may be tried again, and anything else is the server's fault.
   */
  const failureOf = (error: unknown, lost?: (why: string) => AgentError): AgentError => {
    if (error instanceof AgentError) return error;
    const reason = (error as { reason?: { _tag?: string; response?: { status: number } } }).reason;
    if (reason?._tag === "EncodeError" || reason?._tag === "InvalidUrlError") {
      return agentError("internal", `this client could not make a request of ${baseUrl}: ${String(error)}`);
    }
    const unreached = reason?._tag === "TransportError";
    const why = unreached
      ? `could not reach the agent at ${baseUrl}: ${String(error)}`
      : `the agent at ${baseUrl} answered what this client cannot read: ${String(error)}`;
    if (lost !== undefined) return lost(why);
    const status = reason?.response?.status;
    return unreached || (status !== undefined && status >= 500) ? unavailable(why) : agentError("internal", why);
  };
  const unavailable = (why: string) => agentError("unavailable", why);

  /**
   * A refusal at a status the contract does not declare, a later server's: its body says what it is, as any refusal's
   * does (§7.1). A body that is not one (a proxy's page) leaves the failure the request met.
   */
  const refusalIn = (error: unknown): Effect.Effect<never, unknown> => {
    const response = (error as { reason?: { response?: HttpClientResponse.HttpClientResponse } }).reason?.response;
    if (response === undefined || response.status < 400) return Effect.fail(error);
    return response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Refusal)),
      Effect.matchEffect({ onSuccess: Effect.fail, onFailure: () => Effect.fail(error) }),
    );
  };

  /** A request: rejected with its signal's reason once its Caller lets go, and with an `AgentError` otherwise. */
  const request = async <A>(
    effect: Effect.Effect<A, unknown>,
    signal?: AbortSignal,
    lost?: (why: string) => AgentError,
  ): Promise<A> => {
    if (signal?.aborted) throw signal.reason;
    const answered = effect.pipe(Effect.catch(refusalIn));
    const exit = await Effect.runPromiseExit(
      (signal === undefined ? answered : Effect.raceFirst(answered, rejected(signal))).pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      ),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    if (signal?.aborted) throw signal.reason;
    throw failureOf(Cause.squash(exit.cause), lost);
  };

  /**
   * Asks again until the message ends or the Caller's `wait` is over: a request waits at most a minute (§7). A request
   * after the first that fails is `failedAfter`'s to say, since for a send the message is recorded by then.
   */
  const waited = async (
    first: (wait: number | undefined) => Promise<Message>,
    options: WaitOptions | undefined,
    failedAfter: (message: Message, error: unknown) => unknown = (_, error) => error,
  ) => {
    const wait = options?.wait === undefined ? undefined : checked(Wait, options.wait, "wait");
    const deadline = wait === undefined ? undefined : Date.now() + wait * 1000;
    const remaining = () => (deadline === undefined ? 0 : Math.max(0, deadline - Date.now()) / 1000);
    const capped = () => Math.min(remaining(), LIMITS.httpWaitSeconds);
    let message = await first(wait === undefined ? undefined : capped());
    while (!hasEnded(message) && remaining() > 0) {
      const { sessionId, id: messageId } = message;
      try {
        message = await request(
          client.getMessage({ params: { sessionId, messageId }, query: { wait: capped() } }),
          options?.signal,
        );
      } catch (error) {
        // A Caller that let go is told its signal's reason, as it is.
        if (options?.signal?.aborted) throw error;
        throw failedAfter(message, error);
      }
    }
    return message;
  };

  /**
   * An event stream: its first read rejects with the request's refusal; once it has delivered anything, a connection
   * that fails or ends before the stream's own end ends it with `stream_error` (§6). A signal ends it, rejecting the
   * read waiting then with its reason.
   */
  const watched = <E extends { readonly type: string }>(
    opened: Effect.Effect<Stream.Stream<{ readonly type: string }, unknown>, unknown>,
    known: ReadonlySet<string>,
    isLast: (event: E) => boolean,
    signal: AbortSignal | undefined,
  ): AsyncIterable<E> => {
    const lostWith = (why: string) => ({ type: "stream_error", error: errorData(unavailable(why)) }) as unknown as E;
    let ended = false;
    const events = Stream.unwrap(
      opened.pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.catch(refusalIn),
        Effect.mapError((error) => failureOf(error)),
        Effect.map((stream) =>
          stream.pipe(
            // A type a later server sends is not one this Caller can be handed (§7.1).
            Stream.filter((event): event is E => known.has(event.type)),
            Stream.catchCause((cause) =>
              Stream.make(lostWith(`the connection to the agent failed: ${String(Cause.squash(cause))}`)),
            ),
            Stream.takeUntil((event) => {
              ended = event.type === "stream_error" || isLast(event);
              return ended;
            }),
            Stream.concat(
              Stream.suspend(() => (ended ? Stream.empty : Stream.make(lostWith("the agent ended the stream")))),
            ),
          ),
        ),
      ),
    );
    if (signal === undefined) return Stream.toAsyncIterable(events);
    const iterable = Stream.toAsyncIterable(events.pipe(Stream.interruptWhen(rejected(signal))));
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = iterable[Symbol.asyncIterator]();
        return {
          // The read waiting when the signal fires rejects with its reason, and so does every read after it.
          next: async () => {
            if (signal.aborted) throw signal.reason;
            return iterator.next();
          },
          return: async () => (await iterator.return?.()) ?? { done: true, value: undefined },
        };
      },
    };
  };

  /** A send carries a key, the Caller's or one of its own, so that one whose answer was lost can be found (§5.2). */
  const keyed = (sendRequest: SendRequest, what: string) => {
    const { sessionId, idempotencyKey, ...rest } = checked(SendRequest, sendRequest, what);
    const key = idempotencyKey ?? crypto.randomUUID();
    return {
      sessionId,
      key,
      body: rest,
      lost: (why: string) =>
        agentError("unconfirmed", `${why}; the message may have been recorded`, { sessionId, idempotencyKey: key }),
    };
  };

  return {
    info: () => request(client.info()),
    usage: () => request(client.usage()),
    sessions: {
      create: async (createOptions) =>
        request(
          client.createSession({ payload: checked(CreateSessionOptions, createOptions ?? {}, "sessions.create") }),
        ),
      get: (sessionId) => request(client.getSession({ params: { sessionId } })),
      list: async (listOptions) =>
        (await request(
          client.listSessions({ query: checked(ListOptions, listOptions ?? {}, "sessions.list") }),
        )) as Page<Awaited<ReturnType<Agent["sessions"]["get"]>>>,
      update: async (sessionId, changes) =>
        request(
          client.updateSession({ params: { sessionId }, payload: checked(SessionChanges, changes, "sessions.update") }),
        ),
      entries: async (sessionId, entriesOptions) =>
        (await request(
          client.entries({
            params: { sessionId },
            query: checked(EntriesOptions, entriesOptions ?? {}, "sessions.entries"),
          }),
        )) as Awaited<ReturnType<Agent["sessions"]["entries"]>>,
      events: (sessionId, eventsOptions) =>
        watched<SessionEvent>(
          client.events({
            params: { sessionId },
            query: { after: eventsOptions?.after },
            headers: { "last-event-id": undefined },
          }),
          SESSION_EVENT_TYPES,
          () => false,
          eventsOptions?.signal,
        ),
      cancel: async (sessionId) => {
        const { stopped } = await request(client.cancel({ params: { sessionId } }));
        return { stopped: [...stopped] };
      },
      compact: async (sessionId, compactOptions) => {
        await request(
          client.compact({
            params: { sessionId },
            payload: checked(CompactOptions, compactOptions ?? {}, "sessions.compact"),
          }),
        );
      },
      attachment: (sessionId, ref) =>
        request(
          Effect.gen(function* () {
            const response = yield* client.attachment({ params: { sessionId, ref }, responseMode: "response-only" });
            if (response.status !== 200) {
              // A refusal fails here, decoded; a body this endpoint never answers a refusal with is said as such.
              yield* decodeAttachmentRefusal(response);
              return yield* Effect.fail(agentError("internal", `the agent answered ${response.status} with an image`));
            }
            const data = new Uint8Array(yield* response.arrayBuffer);
            return { mimeType: response.headers["content-type"] ?? "application/octet-stream", data };
          }),
        ),
    },
    messages: {
      send: async (sendRequest, sendOptions) => {
        const { sessionId, key, body, lost } = keyed(sendRequest, "messages.send");
        return waited(
          (wait) =>
            request(
              client.send({
                params: { sessionId },
                headers: { "idempotency-key": key },
                payload: { ...body, wait },
              }) as Effect.Effect<Message, unknown>,
              sendOptions?.signal,
              lost,
            ),
          sendOptions,
          // Recorded, as the in-process send says of a wait that failed (agent-api.md §5.2).
          (message, error) =>
            agentError(
              "unconfirmed",
              `The message was recorded, and waiting for it failed: ${error instanceof Error ? error.message : String(error)}`,
              { sessionId, messageId: message.id, idempotencyKey: key },
            ),
        );
      },
      stream: (sendRequest, streamOptions) => {
        let messageId: string | undefined;
        return watched<MessageStreamEvent>(
          // Checked on the first read, which a refusal rejects (§6.2).
          Effect.try({ try: () => keyed(sendRequest, "messages.stream"), catch: (error) => error }).pipe(
            Effect.flatMap(({ sessionId, key, body, lost }) =>
              (
                client.send({
                  params: { sessionId },
                  headers: { "idempotency-key": key },
                  payload: { ...body, stream: true },
                }) as Effect.Effect<Stream.Stream<{ readonly type: string }, unknown>, unknown>
              ).pipe(
                // The answer begins once the message is recorded, so one that never came may have been (§5.2).
                Effect.catch(refusalIn),
                Effect.mapError((error) => failureOf(error, lost)),
              ),
            ),
          ),
          MESSAGE_STREAM_EVENT_TYPES,
          (event) => {
            if (event.type === "message") messageId = event.message.id;
            return event.type === "done" && event.message.id === messageId;
          },
          streamOptions?.signal,
        );
      },
      get: async (key, getOptions) => {
        const at = checked(MessageKey, key, "messages.get");
        return waited(
          (wait) =>
            request(
              "messageId" in at
                ? client.getMessage({ params: at, query: { wait } })
                : client.getMessageByKey({ params: at, query: { wait } }),
              getOptions?.signal,
            ),
          getOptions,
        );
      },
    },
  };
}

const decodeAttachmentRefusal = HttpApiClient.decodeResponse(AgentHttpApi, { group: "agent", endpoint: "attachment" });
