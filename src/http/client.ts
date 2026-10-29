/**
 * An Agent over HTTP (SPEC.md §8, §9): the interface `openAgent` gives in process, called through the contract the
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

const reasonOf = (error: unknown) => (error as { reason?: { _tag?: string; response?: { status: number } } }).reason;

/** A request this client could not make: it never left. */
const unsent = (error: unknown) => ["EncodeError", "InvalidUrlError"].includes(reasonOf(error)?._tag ?? "");

const said = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What stopped a request that left, said for a Caller. */
const whatFailed = (baseUrl: string, error: unknown) =>
  reasonOf(error)?._tag === "TransportError"
    ? `could not reach the agent at ${baseUrl}: ${said(error)}`
    : `the agent at ${baseUrl} answered what this client cannot read: ${said(error)}`;

/**
 * A read's failure, and a write's other than a send's: a refusal as the agent answered it; one that could not get
 * through or met a server's error may be sent again, since repeating any request but a send does no harm (§7);
 * anything else is not the Caller's to retry.
 */
function readFailure(baseUrl: string, error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (unsent(error))
    return agentError("internal", `this client could not make a request of ${baseUrl}: ${said(error)}`);
  const reason = reasonOf(error);
  const status = reason?.response?.status;
  const again = reason?._tag === "TransportError" || (status !== undefined && status >= 500);
  return agentError(again ? "unavailable" : "internal", whatFailed(baseUrl, error));
}

/** How far a send got: its key once it is made, and its message's id once that is known. */
interface SendStage {
  sessionId: string;
  key: string;
  messageId?: string;
}

/**
 * A send's failure, by how far it got (§5.2), the one place that says so. Refused before it was recorded, it is the
 * refusal; recorded, or perhaps recorded, it is `unconfirmed` with what finds it: the key, the client's own when the
 * Caller gave none, and the message's id once known.
 */
function sendFailure(baseUrl: string, stage: SendStage, error: unknown): AgentError {
  const { sessionId, key, messageId } = stage;
  const finds = { sessionId, idempotencyKey: key, ...(messageId === undefined ? {} : { messageId }) };
  if (error instanceof AgentError && error.code === "unconfirmed") {
    const known = typeof error.details === "object" && error.details !== null ? error.details : {};
    return new AgentError({ ...errorData(error), details: { ...known, ...finds } });
  }
  if (messageId !== undefined) {
    return agentError("unconfirmed", `The message was recorded, and waiting for it failed: ${said(error)}`, finds);
  }
  if (error instanceof AgentError) return error;
  if (unsent(error)) return readFailure(baseUrl, error);
  return agentError("unconfirmed", `${whatFailed(baseUrl, error)}; the message may have been recorded`, finds);
}

export function connectAgent(url: string, options: ConnectOptions): Agent {
  const client = Effect.runSync(
    HttpApiClient.make(AgentHttpApi, {
      baseUrl: url,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(options.apiKey)),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ).agent;
  const read = (error: unknown) => readFailure(url, error);
  const sent = (stage: SendStage) => (error: unknown) => sendFailure(url, stage, error);

  /**
   * A request: rejected with its signal's reason once its Caller lets go, and otherwise with what `failure` makes of
   * the failure, as it met it.
   */
  const request = async <A>(
    effect: Effect.Effect<A, unknown>,
    signal?: AbortSignal,
    failure: (error: unknown) => AgentError = read,
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
    throw failure(Cause.squash(exit.cause));
  };

  /**
   * Asks again until the message ends or the Caller's `wait` is over: a request waits at most a minute (§7). What a
   * request after the first that fails means is `failureAfter`'s to say: for a send, the message is recorded by then.
   */
  const waited = async (
    first: (wait: number | undefined) => Promise<Message>,
    options: WaitOptions | undefined,
    failureAfter: (message: Message) => (error: unknown) => AgentError = () => read,
  ) => {
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
        failureAfter(message),
      );
    }
    return message;
  };

  /**
   * An event stream. Until it has delivered an event, a failure rejects its first read with what `refused` makes of
   * it, an answer that ends before its first event included; once it has, a connection that fails or ends before the
   * stream's own end ends it with `stream_error` (§6). A signal ends it, rejecting the read waiting then with its reason.
   */
  const watched = <E extends { readonly type: string }>(
    opened: Effect.Effect<Stream.Stream<{ readonly type: string }, unknown>, unknown>,
    stream: {
      known: ReadonlySet<string>;
      isLast: (event: E) => boolean;
      refused: (error: unknown) => AgentError;
      signal: AbortSignal | undefined;
    },
  ): AsyncIterable<E> => {
    const { known, isLast, refused, signal } = stream;
    const lostWith = (why: string) =>
      ({ type: "stream_error", error: errorData(agentError("unavailable", why)) }) as unknown as E;
    let delivered = false;
    let ended = false;
    const events = Stream.unwrap(
      opened.pipe(Effect.catch(refusalIn), Effect.provideService(HttpClient.TracerPropagationEnabled, false)),
    ).pipe(
      // A type a later server sends is not one this Caller can be handed (§7.1).
      Stream.filter((event): event is E => known.has(event.type)),
      Stream.tap(() =>
        Effect.sync(() => {
          delivered = true;
        }),
      ),
      Stream.catchCause((cause) =>
        delivered
          ? Stream.make(lostWith(`the connection to the agent failed: ${said(Cause.squash(cause))}`))
          : Stream.fail(refused(Cause.squash(cause))),
      ),
      Stream.takeUntil((event) => {
        ended = event.type === "stream_error" || isLast(event);
        return ended;
      }),
      Stream.concat(
        Stream.suspend(() => {
          if (ended) return Stream.empty;
          if (delivered) return Stream.make(lostWith("the agent ended the stream"));
          return Stream.fail(refused(new Error("the answer ended before its first event")));
        }),
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
    const { sessionId, idempotencyKey, ...body } = checked(SendRequest, sendRequest, what);
    return { stage: { sessionId, key: idempotencyKey ?? crypto.randomUUID() }, body };
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
          { known: SESSION_EVENT_TYPES, isLast: () => false, refused: read, signal: eventsOptions?.signal },
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
        const { stage, body } = keyed(sendRequest, "messages.send");
        return waited(
          (wait) =>
            request(
              client.send({
                params: { sessionId: stage.sessionId },
                headers: { "idempotency-key": stage.key },
                payload: { ...body, wait },
              }) as Effect.Effect<Message, unknown>,
              sendOptions?.signal,
              sent(stage),
            ),
          sendOptions,
          (message) => sent({ ...stage, messageId: message.id }),
        );
      },
      stream: (sendRequest, streamOptions) => {
        // Checked on the first read, which a refusal rejects (§6.2): until then there is no stage to fail at.
        let stage: SendStage | undefined;
        let messageId: string | undefined;
        return watched<MessageStreamEvent>(
          Effect.try({ try: () => keyed(sendRequest, "messages.stream"), catch: (error) => error }).pipe(
            Effect.flatMap((keying) => {
              stage = keying.stage;
              return client.send({
                params: { sessionId: keying.stage.sessionId },
                headers: { "idempotency-key": keying.stage.key },
                payload: { ...keying.body, stream: true },
              }) as Effect.Effect<Stream.Stream<{ readonly type: string }, unknown>, unknown>;
            }),
          ),
          {
            known: MESSAGE_STREAM_EVENT_TYPES,
            isLast: (event) => {
              if (event.type === "message") messageId = event.message.id;
              return event.type === "done" && event.message.id === messageId;
            },
            // The answer begins once the message is recorded, so a failure before its first event is a send's.
            refused: (error) => (stage === undefined ? read(error) : sent(stage)(error)),
            signal: streamOptions?.signal,
          },
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
