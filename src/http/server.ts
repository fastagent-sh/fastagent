/**
 * The Agent API served over HTTP (SPEC.md §9): the contract's routes answered by an in-process Agent, behind the
 * instance's keys. A Fetch handler, so it mounts beside the channels' routes on whatever server serves them.
 */
import * as ByteSize from "effect/ByteSize";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import { HttpIncomingMessage, HttpRouter, HttpServer, HttpServerError, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError, OpenApi } from "effect/http-api";
import { type Agent, AgentError, LIMITS, type SessionEvent, agentError, errorData } from "../agent-api.ts";
import type { ChannelHandler } from "../channel.ts";
import { secretEquals } from "../channels/secret.ts";
import { PortFailure, port, portAbort } from "../effect-port.ts";
import { log } from "../log.ts";
import {
  API_PREFIX,
  AgentHttpApi,
  Authorization,
  Malformed,
  MessageStreamEventFrame,
  SessionEventFrame,
} from "./contract.ts";

/** The instance's keys: several, separated by commas, so a key is replaced without a gap (§9.1). */
export const API_KEY_VARIABLE = "FASTAGENT_API_KEY";

/**
 * Whether the definition turns the Agent API off (`http.api: false`): the one reading of it, which every serve the CLI
 * runs and `deploy` make, so a key a host still holds cannot serve an API the definition turned off.
 */
export function apiTurnedOff(config: { http?: { api?: boolean } }): boolean {
  return config.http?.api === false;
}

export const API_TURNED_OFF = "fastagent.config.ts says http.api: false";

export function apiKeysFrom(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
}

const MAX_BODY = ByteSize.mebibytes(32);
/** Proxies close a connection that says nothing for a minute or so; a comment keeps an event stream open (§9.3). */
const KEEP_ALIVE_MS = 15_000;
/** A stream told to end does in a millisecond; this bounds the wait for one whose Caller stopped reading. */
const STREAMS_END_MS = 100;
/** How soon a refused Caller may try again; the same for every refusal that says so (§9.4). */
const RETRY_AFTER_SECONDS = "1";

export interface ApiHandler {
  fetch: ChannelHandler;
  /**
   * Ends every open event stream with a `stream_error`, and answers once they have ended, so that the server's close
   * does not wait on a Caller still watching: at most {@link STREAMS_END_MS}, past which one whose Caller stopped reading
   * is left to the server's own grace.
   */
  endStreams(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ApiOptions {
  keys: readonly string[];
  /** For tests: the longest a request waits, and how often a quiet stream says it is open. */
  waitCapSeconds?: number;
  keepAliveMs?: number;
}

/** An operation's failure as the Agent API answers it: an `AgentError` as it is, anything else `internal`, logged. */
function refusal(operation: string) {
  return (failure: PortFailure): AgentError => {
    const error = failure.cause;
    if (error instanceof AgentError) return error;
    log.error(`[api] ${operation} failed: ${String(error)}`);
    return agentError("internal", `${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
  };
}

/** An Agent operation, told to let go if its request does (a Caller that left). */
function call<A>(operation: string, run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, AgentError> {
  return Effect.suspend(() => {
    const controller = new AbortController();
    return portAbort(
      operation,
      () => run(controller.signal),
      () => controller.abort(),
    );
  }).pipe(Effect.mapError(refusal(operation)));
}

const json = (status: number, error: AgentError) =>
  HttpServerResponse.jsonUnsafe({ error: errorData(error) }, { status });

/**
 * What the contract cannot say itself: a body over the limit, a body that is not JSON (which the contract answers 415
 * with a line of text) and a route it does not have, answered as refusals like any other, and `Retry-After` on every
 * refusal a Caller may send again later.
 */
const Edges = HttpRouter.middleware(
  (app) =>
    app.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        if (HttpServerError.isHttpServerError(error)) {
          if (error.reason._tag === "RouteNotFound") {
            return Effect.succeed(json(404, agentError("not_found", "the Agent API has no such route")));
          }
          if (error.reason._tag === "RequestParseError" && error.reason.reason === "BodyTooLarge") {
            return Effect.succeed(
              json(413, agentError("invalid_request", "the request body is over 32 MiB", { reason: "too_large" })),
            );
          }
        }
        return Effect.failCause(cause);
      }),
      Effect.map((response) => {
        if (response.status === 415) {
          return json(
            400,
            agentError("invalid_request", "a request body is JSON: send Content-Type: application/json"),
          );
        }
        return response.status === 429 || response.status === 503
          ? HttpServerResponse.setHeader(response, "retry-after", RETRY_AFTER_SECONDS)
          : response;
      }),
    ),
  { global: true },
);

export function apiHandler(agent: Agent, options: ApiOptions): ApiHandler {
  // An empty key matches nothing (secretEquals), so serving with one would refuse every Caller without a word.
  if (options.keys.length === 0 || options.keys.some((key) => key.trim() === "")) {
    throw new Error("the Agent API needs at least one key, and no key may be empty");
  }
  const keys = [...options.keys];
  const waitCap = options.waitCapSeconds ?? LIMITS.httpWaitSeconds;
  const keepAlive = options.keepAliveMs ?? KEEP_ALIVE_MS;
  const capped = (wait: number | undefined) => (wait === undefined ? undefined : Math.min(wait, waitCap));
  const closing = new AbortController();
  /** The event streams being written, each until it has ended. */
  const streaming = new Set<Promise<void>>();
  const closed = Effect.callback<void>((resume) => {
    if (closing.signal.aborted) return resume(Effect.void);
    const onAbort = () => resume(Effect.void);
    closing.signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => closing.signal.removeEventListener("abort", onAbort));
  });

  /**
   * An event stream: refused on its first read with that read's error and status, as `sessions.events` and
   * `messages.stream` are; then its events as server-sent, with a comment while it is quiet. A service that closes
   * ends it with `stream_error`.
   */
  const serverSent = <E extends { readonly type: string }>(
    operation: string,
    frame: Schema.Codec<
      { readonly type: string },
      { readonly id?: string | undefined; readonly event: string; readonly data: string }
    >,
    open: () => AsyncIterable<E>,
  ) =>
    Effect.gen(function* () {
      const iterator = open()[Symbol.asyncIterator]();
      const first = yield* port(() => iterator.next()).pipe(
        Effect.onInterrupt(() => Effect.promise(async () => iterator.return?.())),
        Effect.mapError(refusal(operation)),
      );
      const rest = Stream.fromAsyncIterable({ [Symbol.asyncIterator]: () => iterator }, (error) => error);
      const written = (event: { readonly type: string }) =>
        Schema.encodeEffect(frame)(event).pipe(
          Effect.map(({ id, event, data }) => Sse.encoder.write({ _tag: "Event", id, event, data })),
        );
      const endedWith = (error: AgentError) =>
        Stream.fromEffect(Effect.orDie(written({ type: "stream_error", error: errorData(error) } as SessionEvent)));
      const events = (first.done ? Stream.empty : Stream.concat(Stream.make(first.value), rest)).pipe(
        // Written before a failure is caught, so an event the API cannot send ends the stream as what it is.
        Stream.mapEffect(written),
        Stream.catchCause((cause) => endedWith(refusal(operation)(new PortFailure(Cause.squash(cause))))),
        Stream.interruptWhen(closed),
        Stream.concat(
          Stream.suspend(() =>
            closing.signal.aborted ? endedWith(agentError("unavailable", "the service is closing")) : Stream.empty,
          ),
        ),
      );
      let ended!: () => void;
      const done = new Promise<void>((resolve) => {
        ended = resolve;
      });
      const body = Stream.merge(events, Stream.tick(`${keepAlive} millis`).pipe(Stream.map(() => ": open\n\n")), {
        haltStrategy: "left",
      }).pipe(
        Stream.encodeText,
        Stream.onStart(Effect.sync(() => streaming.add(done))),
        Stream.ensuring(
          Effect.sync(() => {
            streaming.delete(done);
            ended();
          }),
        ),
      );
      return HttpServerResponse.stream(body, {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-store" },
      });
    });

  const openapi = OpenApi.fromApi(AgentHttpApi);

  const handlers = HttpApiBuilder.group(AgentHttpApi, "agent", (handlers) =>
    handlers
      .handle("info", () => call("info", () => agent.info()))
      .handle("usage", () => call("usage", () => agent.usage()))
      .handle("openapi", () => Effect.succeed(HttpServerResponse.jsonUnsafe(openapi)))
      .handle("createSession", ({ payload }) =>
        call("sessions.create", () => agent.sessions.create(payload ?? undefined)),
      )
      .handle("listSessions", ({ query }) => call("sessions.list", () => agent.sessions.list(query)))
      .handle("getSession", ({ params }) => call("sessions.get", () => agent.sessions.get(params.sessionId)))
      .handle("updateSession", ({ params, payload }) =>
        call("sessions.update", () => agent.sessions.update(params.sessionId, payload)),
      )
      .handle("entries", ({ params, query }) =>
        call("sessions.entries", () => agent.sessions.entries(params.sessionId, query)),
      )
      .handle("events", ({ params, query, headers }) =>
        serverSent("sessions.events", SessionEventFrame, () =>
          // An EventSource reconnects to the URL it opened and says where it got to in this header (§9.3).
          agent.sessions.events(params.sessionId, { after: headers["last-event-id"] ?? query.after }),
        ),
      )
      .handle("cancel", ({ params }) => call("sessions.cancel", () => agent.sessions.cancel(params.sessionId)))
      .handle("compact", ({ params, payload }) =>
        call("sessions.compact", () => agent.sessions.compact(params.sessionId, payload ?? undefined)),
      )
      .handle("attachment", ({ params }) =>
        call("sessions.attachment", () => agent.sessions.attachment(params.sessionId, params.ref)).pipe(
          Effect.map(({ mimeType, data }) => HttpServerResponse.uint8Array(data, { contentType: mimeType })),
        ),
      )
      .handle("send", ({ params, headers, payload }) => {
        const { wait, stream, ...message } = payload;
        const request = { ...message, sessionId: params.sessionId, idempotencyKey: headers["idempotency-key"] };
        if (!stream) {
          return call("messages.send", (signal) => agent.messages.send(request, { wait: capped(wait), signal }));
        }
        if (wait !== undefined) {
          return Effect.fail(agentError("invalid_request", "a streamed message is watched, not waited for: drop wait"));
        }
        return serverSent("messages.stream", MessageStreamEventFrame, () => agent.messages.stream(request));
      })
      .handle("getMessage", ({ params, query }) =>
        call("messages.get", (signal) => agent.messages.get(params, { wait: capped(query.wait), signal })),
      )
      .handle("getMessageByKey", ({ params, query }) =>
        call("messages.get", (signal) => agent.messages.get(params, { wait: capped(query.wait), signal })),
      ),
  );

  const authorization = Layer.succeed(Authorization)({
    bearer: (effect, { credential }) => {
      const given = Redacted.value(credential);
      return keys.some((key) => secretEquals(given, key))
        ? effect
        : Effect.fail(agentError("unauthorized", "the request has no key this instance holds"));
    },
  });
  // The middleware wraps the whole handler, so it also sees the answer failing to encode: the server's fault, not the
  // Caller's, said in the log and answered `internal`, as Effect itself tells the two apart.
  const malformed = Layer.succeed(Malformed)((effect) =>
    Effect.catchIf(effect, HttpApiError.HttpApiSchemaError.is, (error) => {
      // The middleware's own error type hides what it is; the guard above said.
      const { kind, cause } = error as unknown as HttpApiError.HttpApiSchemaError;
      if (kind !== "Body" && kind !== "ResponseHeaders") {
        return Effect.fail(agentError("invalid_request", `${kind}: ${cause.message}`));
      }
      log.error(`[api] an answer did not match the Agent API: ${cause.message}`);
      return Effect.fail(agentError("internal", `the agent's answer did not match the Agent API: ${cause.message}`));
    }),
  );

  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(HttpApiBuilder.layer(AgentHttpApi), Edges).pipe(
      Layer.provide(handlers),
      Layer.provide([authorization, malformed]),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(Layer.succeed(HttpIncomingMessage.MaxBodySize)(MAX_BODY)),
    ),
    { disableLogger: true },
  );
  return {
    fetch: (request) => handler(request),
    endStreams: async () => {
      closing.abort();
      await Promise.race([Promise.all(streaming), new Promise((resolve) => setTimeout(resolve, STREAMS_END_MS))]);
    },
    dispose,
  };
}

/** Whether `path` is the Agent API's, which a channel's route may not take. */
export function isApiPath(path: string): boolean {
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
}
