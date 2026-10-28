/**
 * An Agent over HTTP (agent-api.md §8, §9): the interface `openAgent` gives in process, called through the contract the
 * server answers from. Runs wherever `fetch` does (Node, Bun, Deno, Workers): nothing here needs a runtime's own API.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
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
import { AgentHttpApi, MESSAGE_STREAM_EVENT_TYPES, SESSION_EVENT_TYPES } from "./contract.ts";

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
   * A failure as the Agent API's. A refusal the agent answered is decoded as it was sent; a request that got no
   * answer it can read is `lost`'s to say, since only the operation knows whether it may have been carried out.
   */
  const failureOf = (cause: Cause.Cause<unknown>, lost: (why: string) => AgentError): unknown => {
    const error = Cause.squash(cause);
    if (error instanceof AgentError) return error;
    const reason = (error as { reason?: { _tag?: string; response?: { status: number } } }).reason;
    if (reason?._tag === "TransportError") return lost(`could not reach the agent at ${baseUrl}: ${String(error)}`);
    const status = reason?.response?.status;
    if (status === 502 || status === 503 || status === 504) {
      return lost(`the agent at ${baseUrl} is not answering (${status})`);
    }
    return agentError("internal", `the agent at ${baseUrl} answered what this client cannot read: ${String(error)}`);
  };
  const unavailable = (why: string) => agentError("unavailable", why);

  /** A request: rejected with its signal's reason once its Caller lets go, and with an `AgentError` otherwise. */
  const request = async <A>(
    effect: Effect.Effect<A, unknown>,
    signal?: AbortSignal,
    lost: (why: string) => AgentError = unavailable,
  ): Promise<A> => {
    if (signal?.aborted) throw signal.reason;
    const exit = await Effect.runPromiseExit(
      (signal === undefined ? effect : Effect.raceFirst(effect, rejected(signal))).pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      ),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    if (signal?.aborted) throw signal.reason;
    throw failureOf(exit.cause, lost);
  };

  /** Asks again until the message ends or the Caller's `wait` is over: a request waits at most a minute (§7). */
  const waited = async (first: (wait: number | undefined) => Promise<Message>, options?: WaitOptions) => {
    const wait = options?.wait === undefined ? undefined : checked(Wait, options.wait, "wait");
    const deadline = wait === undefined ? undefined : Date.now() + wait * 1000;
    const remaining = () => (deadline === undefined ? 0 : Math.max(0, deadline - Date.now()) / 1000);
    const capped = () => Math.min(remaining(), LIMITS.httpWaitSeconds);
    let message = await first(wait === undefined ? undefined : capped());
    while (!hasEnded(message) && remaining() > 0) {
      const { sessionId, id: messageId } = message;
      message = await request(
        client.getMessage({ params: { sessionId, messageId }, query: { wait: capped() } }),
        options?.signal,
      );
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
        Effect.mapError((error) => failureOf(Cause.fail(error), unavailable)),
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
        );
      },
      stream: (sendRequest, streamOptions) => {
        let messageId: string | undefined;
        return watched<MessageStreamEvent>(
          // Checked on the first read, which a refusal rejects (§6.2).
          Effect.try({ try: () => keyed(sendRequest, "messages.stream"), catch: (error) => error }).pipe(
            Effect.flatMap(
              ({ sessionId, key, body }) =>
                client.send({
                  params: { sessionId },
                  headers: { "idempotency-key": key },
                  payload: { ...body, stream: true },
                }) as Effect.Effect<Stream.Stream<{ readonly type: string }, unknown>, unknown>,
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
