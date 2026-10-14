/**
 * SPEC v1 over HTTP (docs/SPEC-v1.md §9): the user plane (`POST /invoke`, `/sessions`, `/agent`) and the control plane
 * (`/control`), each a mount a gateway can treat apart. A failed result is answered with its code's status and
 * `{ "error": AgentError }`; a request is decoded here, the one place untyped input becomes a typed one.
 *
 * Authenticates nobody, like every route this process serves: that belongs to a gateway in front.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ChannelHandler, Routes } from "../channel.ts";
import { log } from "../log.ts";
import {
  type Agent,
  type AgentError,
  AgentRejection,
  type FollowEvent,
  type InvokeEvent,
  type RunStatus,
  agentError,
} from "../protocol.ts";
import { readBodyCapped } from "./body.ts";
import { MAX_BODY_BYTES } from "./http.ts";
import { text } from "./respond.ts";
import { type PrefixMount, parseRouteKey, withoutBody } from "./serve.ts";
import { sseResponse } from "./sse.ts";

/** SPEC v1 §7.1: each code's HTTP status. An unknown code is a server fault. */
const STATUS: Record<string, number> = {
  invalid_request: 400,
  unsupported: 501,
  not_found: 404,
  conflict: 409,
  busy: 429,
  missing_model: 422,
  auth_required: 422,
  model_error: 502,
  nothing_to_compact: 409,
  partial_update: 500,
  unavailable: 503,
  internal: 500,
};

/** What `attachments/{ref}` may answer under the image's own type: a sender-declared `text/html` would run script. */
const RASTER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const json = (value: unknown, status = 200): Response =>
  new Response(`${JSON.stringify(value)}\n`, { status, headers: { "content-type": "application/json" } });

const refused = (error: AgentError): Response => json({ error }, STATUS[error.code] ?? 500);

const invalid = (message: string): Response => refused(agentError("invalid_request", message));

/** A result: its own body when it succeeded, its error under its code's status when it did not. */
const answer = (result: { ok: true } | { ok: false; error: AgentError }, ok = 200): Response =>
  result.ok ? json(result, ok) : refused(result.error);

/** A read with no failure branch rejects with an `AgentRejection` (SPEC v1 §2); anything else is a fault. */
async function read<T>(work: () => Promise<T>, respond: (value: T) => Response): Promise<Response> {
  try {
    return respond(await work());
  } catch (error) {
    if (error instanceof AgentRejection) {
      return refused({ code: error.code, message: error.message, retryable: error.retryable });
    }
    throw error;
  }
}

// ── Request bodies ───────────────────────────────────────────────────────────

const Image = Schema.Struct({ mimeType: Schema.String, data: Schema.String });
const Prompt = Schema.Struct({ text: Schema.String, images: Schema.optionalKey(Schema.Array(Image)) });

const InvokeBody = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  prompt: Prompt,
  whenBusy: Schema.optionalKey(Schema.Literals(["queue", "steer", "reject"])),
  idempotencyKey: Schema.optionalKey(Schema.String),
});

const CreateBody = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  fork: Schema.optionalKey(Schema.Struct({ sessionId: Schema.String, entryId: Schema.optionalKey(Schema.String) })),
});

const RewindBody = Schema.Struct({ entryId: Schema.String });
const CompactBody = Schema.Struct({ instructions: Schema.optionalKey(Schema.String) });
const UpdateBody = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  thinkingLevel: Schema.optionalKey(Schema.String),
});

/** The body as the schema says, or the answer that it is not. An unknown field is refused, never dropped. */
async function decoded<S extends Schema.Top>(
  req: Request,
  schema: S,
): Promise<{ value: S["Type"] } | { error: Response }> {
  const body = await readBodyCapped(req, MAX_BODY_BYTES);
  if ("tooLarge" in body) return { error: refused(agentError("invalid_request", "the body is larger than 1 MiB")) };
  let raw: unknown = {};
  if (body.text.trim() !== "") {
    try {
      raw = JSON.parse(body.text);
    } catch {
      return { error: invalid("the body is not JSON") };
    }
  }
  const result = Schema.decodeUnknownResult(schema as never, { onExcessProperty: "error" })(raw);
  return Result.isSuccess(result)
    ? { value: result.success as S["Type"] }
    : { error: invalid(String(result.failure.message)) };
}

// ── Streams ──────────────────────────────────────────────────────────────────

/** The first event, and an iterable of it and the rest: whether a stream was refused decides the response. */
async function opened<T>(events: AsyncIterable<T>): Promise<{ first?: T; all: AsyncIterable<T>; detach(): void }> {
  const iterator = events[Symbol.asyncIterator]();
  const head = await iterator.next();
  let taken = false;
  const all: AsyncIterable<T> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (!taken && !head.done) {
          taken = true;
          return head;
        }
        return iterator.next();
      },
      return: async () => (await iterator.return?.()) ?? { done: true, value: undefined },
    }),
  };
  return { ...(head.done ? {} : { first: head.value }), all, detach: () => void iterator.return?.() };
}

const entryId = (event: FollowEvent | InvokeEvent): string | undefined =>
  event.type === "entry" ? event.entry.id : undefined;

/** A stream that may be refused before it starts: refused, it is an error status; started, an event stream. */
async function stream(events: AsyncIterable<FollowEvent | InvokeEvent>): Promise<Response> {
  const { first, all } = await opened(events);
  if (first?.type === "rejected") return refused(first.error);
  return sseResponse(all, (event) => event, entryId);
}

// ── Routing ──────────────────────────────────────────────────────────────────

type Params = Record<string, string>;
type Handler = (req: Request, url: URL, params: Params) => Response | Promise<Response>;

/**
 * A mounted table of `"<METHOD> <path>"` → handler, where a `{name}` segment is a percent-encoded variable. A segment
 * that does not decode, or decodes to an id no URL can carry, matches nothing.
 */
function app(table: Record<string, Handler>): ChannelHandler {
  const routes = Object.entries(table).map(([key, handler]) => {
    const { method, path } = parseRouteKey(key);
    return { method, segments: path.split("/"), handler };
  });
  return async (req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/");
    const hits: { route: (typeof routes)[number]; params: Params }[] = [];
    for (const route of routes) {
      if (route.segments.length !== segments.length) continue;
      const params: Params = {};
      const matched = route.segments.every((expected, i) => {
        const actual = segments[i] as string;
        if (!expected.startsWith("{")) return expected === actual;
        if (actual === "") return false;
        try {
          params[expected.slice(1, -1)] = decodeURIComponent(actual);
          return true;
        } catch {
          return false;
        }
      });
      if (matched) hits.push({ route, params });
    }
    const hit =
      hits.find((h) => h.route.method === req.method) ??
      (req.method === "HEAD" ? hits.find((h) => h.route.method === "GET") : undefined);
    let res: Response;
    try {
      res = hit
        ? await hit.route.handler(req, url, hit.params)
        : hits.length > 0
          ? text("method not allowed\n", 405)
          : text("not found\n", 404);
    } catch (error) {
      log.error(`[protocol] ${req.method} ${url.pathname} failed: ${String(error)}`);
      res = refused(agentError("internal", "the request failed on the server"));
    }
    return req.method === "HEAD" ? withoutBody(res) : res;
  };
}

/** A query parameter as a non-negative integer, or the answer that it is not one. */
function limitOf(url: URL): { limit?: number } | { error: Response } {
  const raw = url.searchParams.get("limit");
  if (raw === null) return {};
  return /^\d+$/.test(raw) ? { limit: Number(raw) } : { error: invalid("limit is a non-negative integer") };
}

const optional = <K extends string>(key: K, value: string | null | undefined): { [P in K]?: string } =>
  (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: string };

/** The two planes, as what a host router mounts: the user plane's routes and prefixes, and the control prefix. */
export function protocolHttp(agent: Agent): { user: { routes: Routes; mounts: PrefixMount[] }; control: PrefixMount } {
  const runOf = (run: RunStatus | undefined): Response => json(run ?? null);

  const invoke = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return text("POST only\n", 405);
    const body = await readBodyCapped(req, MAX_BODY_BYTES);
    if ("tooLarge" in body) return invalid("the body is larger than 1 MiB");
    let raw: unknown;
    try {
      raw = JSON.parse(body.text);
    } catch {
      return invalid("the body is not JSON");
    }
    // `source` is not a field here: only the server's own channels, schedules and wake-ups set it (SPEC v1 §3.5), so a
    // remote one is refused as the unknown field it is.
    const request = Schema.decodeUnknownResult(InvokeBody, { onExcessProperty: "error" })(raw);
    if (Result.isFailure(request)) return invalid(String(request.failure.message));
    const { prompt, ...rest } = request.success;
    const { first, all, detach } = await opened(
      agent.invoke({
        ...rest,
        prompt: { text: prompt.text, ...(prompt.images ? { images: [...prompt.images] } : {}) },
      }),
    );
    if (first?.type === "rejected") return refused(first.error);
    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("application/json") && !accept.includes("text/event-stream")) {
      // The receipt alone: the run goes on, and the caller follows or polls it.
      detach();
      return json(first, 202);
    }
    return sseResponse(all, (event) => event, entryId);
  };

  const sessions = (_url: URL, params: Params) => agent.sessions.get(params.s as string);

  const user: Record<string, Handler> = {
    "POST /sessions": async (req) => {
      const body = await decoded(req, CreateBody);
      if ("error" in body) return body.error;
      return answer(await agent.sessions.create(body.value), 201);
    },
    "GET /sessions": () =>
      read(
        () => agent.sessions.list(),
        (list) => json(list),
      ),
    "GET /sessions/{s}": async (_req, url, params) => {
      const limit = limitOf(url);
      if ("error" in limit) return limit.error;
      return answer(
        await sessions(url, params).read({
          ...optional("after", url.searchParams.get("after")),
          ...optional("before", url.searchParams.get("before")),
          ...limit,
        }),
      );
    },
    "GET /sessions/{s}/follow": (req, url, params) =>
      stream(
        sessions(url, params).follow(
          optional("after", url.searchParams.get("after") ?? req.headers.get("last-event-id")),
        ),
      ),
    "GET /sessions/{s}/attachments/{ref}": (_req, url, params) =>
      read(
        () => sessions(url, params).attachment(params.ref as string),
        (attachment) =>
          attachment
            ? new Response(Buffer.from(attachment.data, "base64"), {
                headers: {
                  "content-type": RASTER_IMAGE_TYPES.has(attachment.mimeType)
                    ? attachment.mimeType
                    : "application/octet-stream",
                  "x-content-type-options": "nosniff",
                  "cache-control": "private, max-age=31536000, immutable",
                },
              })
            : new Response(null, { status: 404 }),
      ),
    "POST /sessions/{s}/abort": async (_req, url, params) => answer(await sessions(url, params).abort()),
    "POST /sessions/{s}/rewind": async (req, url, params) => {
      const body = await decoded(req, RewindBody);
      if ("error" in body) return body.error;
      return answer(await sessions(url, params).rewind(body.value.entryId));
    },
    "POST /sessions/{s}/compact": async (req, url, params) => {
      const body = await decoded(req, CompactBody);
      if ("error" in body) return body.error;
      return answer(await sessions(url, params).compact(body.value));
    },
    "GET /sessions/{s}/runs": (_req, url, params) => {
      const idempotencyKey = url.searchParams.get("idempotencyKey");
      if (idempotencyKey === null) return invalid("expected ?idempotencyKey=");
      return read(() => sessions(url, params).runs.get({ idempotencyKey }), runOf);
    },
    "GET /sessions/{s}/runs/{r}": (_req, url, params) =>
      read(() => sessions(url, params).runs.get({ runId: params.r as string }), runOf),
    "GET /sessions/{s}/runs/{r}/events": (req, url, params) =>
      stream(
        sessions(url, params).runs.follow(
          params.r as string,
          optional("after", url.searchParams.get("after") ?? req.headers.get("last-event-id")),
        ),
      ),
    "POST /sessions/{s}/runs/{r}/cancel": async (_req, url, params) =>
      answer(await sessions(url, params).runs.cancel(params.r as string)),
  };

  const about: Record<string, Handler> = {
    "GET /agent": () => json(agent.info()),
    "GET /agent/models": () =>
      read(
        () => agent.models(),
        (models) => json(models),
      ),
    "GET /agent/commands": () =>
      read(
        () => agent.commands(),
        (commands) => json(commands),
      ),
  };

  const control: Record<string, Handler> = {
    "PATCH /control/sessions/{s}": async (req, url, params) => {
      const body = await decoded(req, UpdateBody);
      if ("error" in body) return body.error;
      return answer(await sessions(url, params).update(body.value));
    },
    "DELETE /control/sessions/{s}": async (_req, url, params) => answer(await sessions(url, params).delete()),
  };

  return {
    user: {
      routes: { "POST /invoke": invoke },
      mounts: [
        { prefix: "/sessions", handler: app(user) },
        { prefix: "/agent", handler: app(about) },
      ],
    },
    control: { prefix: "/control", handler: app(control) },
  };
}
