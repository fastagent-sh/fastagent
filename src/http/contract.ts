/**
 * The Agent API over HTTP (docs/design/agent-api.md §9) as one `effect/http-api` contract: the server answers from it,
 * `connectAgent` calls through it and `/v1/openapi.json` is generated from it, so none of them can describe another API
 * than the one served. Built from agent-api.ts's schemas; imports nothing that needs Node, so a client runs wherever
 * `fetch` does.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/http-api";
import {
  AgentError,
  AgentErrorData,
  AgentInfo,
  CompactOptions,
  CreateSessionOptions,
  Entry,
  EntriesOptions,
  IdempotencyKey,
  ListOptions,
  Message,
  MessageStreamEvent,
  SendRequest,
  Session,
  SessionChanges,
  SessionEvent,
  Usage,
  Wait,
  errorData,
} from "../agent-api.ts";

export const API_PREFIX = "/v1";

/** The status a refusal answers with (§7). */
export function statusOf(error: AgentErrorData): number {
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  switch (error.code) {
    case "invalid_request":
      return reason === "too_large" ? 413 : 400;
    case "unauthorized":
      return 401;
    case "not_found":
      return 404;
    case "busy":
      return reason === "queue_full" ? 429 : reason === "capacity" ? 503 : 409;
    case "missing_model":
    case "missing_tool":
      return 409;
    case "unavailable":
      return 503;
    default:
      return 500;
  }
}

const isAgentError = Schema.declare((u): u is AgentError => u instanceof AgentError);

/**
 * `{ error }` at `status`. Encoding takes only an error whose status this is, which is how the server's answer gets its
 * status; decoding takes any code, since a later server may answer with one this client does not know (§7.1).
 */
function refusedWith(status: number) {
  return Schema.Struct({ error: AgentErrorData }).pipe(
    Schema.decodeTo(
      isAgentError,
      SchemaTransformation.transformEffect({
        decode: ({ error }) => Effect.succeed(new AgentError(error)),
        encode: (error) =>
          statusOf(error) === status
            ? Effect.succeed({ error: errorData(error) })
            : Effect.fail(new SchemaIssue.Forbidden({ message: `not answered with ${status}` }, error)),
      }),
    ),
    HttpApiSchema.status(status),
  );
}

const Refused = [400, 404, 409, 413, 429, 500, 503].map(refusedWith);

export class Authorization extends HttpApiMiddleware.Service<Authorization>()("fastagent/Authorization", {
  security: { bearer: HttpApiSecurity.bearer },
  error: refusedWith(401),
}) {}

/** A request the contract cannot read (a path, query, header or body), refused `invalid_request`. */
export class Malformed extends HttpApiMiddleware.Service<Malformed>()("fastagent/Malformed", {
  error: refusedWith(400),
}) {}

const typesOf = (events: { members: readonly { fields: { type: { literal: string } } }[] }): ReadonlySet<string> =>
  new Set(events.members.map((member) => member.fields.type.literal));

/** The event types this version defines; a Caller ignores any other (§7.1). */
export const SESSION_EVENT_TYPES = typesOf(SessionEvent);
export const MESSAGE_STREAM_EVENT_TYPES = typesOf(MessageStreamEvent);

/** An event of a type a later server sends and this client does not know: its type, the rest unread. */
const Unknown = Schema.Struct({ type: Schema.String });

/**
 * An event as server-sent: its type as the event's name, the event as its data, and an entry's id as its id, so that
 * `Last-Event-ID` is the last entry a Caller received (§9.3).
 */
function serverSent<S extends Schema.Codec<{ readonly type: string }, unknown>>(events: S, known: ReadonlySet<string>) {
  const json = Schema.fromJsonString(events);
  return Schema.Struct({ id: Schema.optional(Schema.String), event: Schema.String, data: Schema.String }).pipe(
    Schema.decodeTo(
      Schema.Union([Schema.toType(events), Unknown]),
      SchemaTransformation.transformEffect({
        decode: ({ event, data }) =>
          known.has(event)
            ? Schema.decodeUnknownEffect(json)(data).pipe(Effect.mapError((error) => error.issue))
            : Effect.succeed({ type: event }),
        encode: (value) =>
          !known.has(value.type)
            ? Effect.fail(new SchemaIssue.Forbidden({ message: `${value.type} is not an event this API sends` }))
            : Schema.encodeEffect(json)(value as S["Type"]).pipe(
                Effect.mapError((error) => error.issue),
                Effect.map((data) => ({
                  event: value.type,
                  data,
                  ...("entry" in value && value.type === "entry" ? { id: (value.entry as Entry).id } : {}),
                })),
              ),
      }),
    ),
  );
}

export const SessionEventFrame = serverSent(SessionEvent, SESSION_EVENT_TYPES);
export const MessageStreamEventFrame = serverSent(MessageStreamEvent, MESSAGE_STREAM_EVENT_TYPES);

const sessionPath = { sessionId: Schema.String };
const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    data: Schema.Array(item),
    next: Schema.optionalKey(Schema.String),
    prev: Schema.optionalKey(Schema.String),
  });
const { sessionId: _, ...sendFields } = SendRequest.fields;
const { idempotencyKey: __, ...sendBody } = sendFields;

/** `POST …/messages`: the send without its session (the path's) or its key (`Idempotency-Key`). */
const SendBody = Schema.Struct({
  ...sendBody,
  wait: Schema.optional(Wait),
  /** `messages.stream`: the answer is the message's events. */
  stream: Schema.optional(Schema.Boolean),
});

const WaitQuery = { wait: Schema.optional(Schema.NumberFromString.check(Schema.isGreaterThanOrEqualTo(0))) };

const AgentGroup = HttpApiGroup.make("agent")
  .add(
    HttpApiEndpoint.get("info", "/agent", { success: AgentInfo, error: Refused }),
    HttpApiEndpoint.get("usage", "/usage", { success: Usage, error: Refused }),
    HttpApiEndpoint.get("openapi", "/openapi.json", { success: Schema.Json, error: Refused }),
    HttpApiEndpoint.post("createSession", "/sessions", {
      payload: CreateSessionOptions,
      success: Session.pipe(HttpApiSchema.status(201)),
      error: Refused,
    }),
    HttpApiEndpoint.get("listSessions", "/sessions", {
      query: ListOptions,
      success: Page(Session),
      error: Refused,
    }),
    HttpApiEndpoint.get("getSession", "/sessions/:sessionId", {
      params: sessionPath,
      success: Session,
      error: Refused,
    }),
    HttpApiEndpoint.patch("updateSession", "/sessions/:sessionId", {
      params: sessionPath,
      payload: SessionChanges,
      success: Session,
      error: Refused,
    }),
    HttpApiEndpoint.get("entries", "/sessions/:sessionId/entries", {
      params: sessionPath,
      query: EntriesOptions,
      success: Page(Entry),
      error: Refused,
    }),
    HttpApiEndpoint.get("events", "/sessions/:sessionId/events", {
      params: sessionPath,
      query: { after: Schema.optional(Schema.String) },
      headers: { "last-event-id": Schema.optional(Schema.String) },
      success: HttpApiSchema.StreamSse({ events: SessionEventFrame }),
      error: Refused,
    }),
    HttpApiEndpoint.post("cancel", "/sessions/:sessionId/cancel", {
      params: sessionPath,
      success: Schema.Struct({ stopped: Schema.Array(Schema.String) }),
      error: Refused,
    }),
    HttpApiEndpoint.post("compact", "/sessions/:sessionId/compact", {
      params: sessionPath,
      payload: CompactOptions,
      success: HttpApiSchema.Accepted,
      error: Refused,
    }),
    HttpApiEndpoint.get("attachment", "/sessions/:sessionId/attachments/:ref", {
      params: { ...sessionPath, ref: Schema.String },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "image/*" })),
      error: Refused,
    }),
    HttpApiEndpoint.post("send", "/sessions/:sessionId/messages", {
      params: sessionPath,
      headers: { "idempotency-key": Schema.optional(IdempotencyKey) },
      payload: SendBody,
      success: [Message, HttpApiSchema.StreamSse({ events: MessageStreamEventFrame })],
      error: Refused,
    }),
    HttpApiEndpoint.get("getMessage", "/sessions/:sessionId/messages/:messageId", {
      params: { ...sessionPath, messageId: Schema.String },
      query: WaitQuery,
      success: Message,
      error: Refused,
    }),
    HttpApiEndpoint.get("getMessageByKey", "/sessions/:sessionId/messages/by-key/:idempotencyKey", {
      params: { ...sessionPath, idempotencyKey: IdempotencyKey },
      query: WaitQuery,
      success: Message,
      error: Refused,
    }),
  )
  .middleware(Malformed)
  .middleware(Authorization)
  .prefix(API_PREFIX);

export class AgentHttpApi extends HttpApi.make("fastagent")
  .add(AgentGroup)
  .annotateMerge(OpenApi.annotations({ title: "FastAgent Agent API", version: "2" })) {}
