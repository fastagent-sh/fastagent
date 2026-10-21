/**
 * The Agent API over HTTP (docs/design/agent-api.md §10): one Fetch handler for an `Agent`. Requests are decoded here,
 * the one place untyped input becomes typed; every answer is the Agent's own, under its code's status.
 *
 * Authenticates nobody: who may reach it is decided in front of it (§8). Until the move lands (#788) it runs beside
 * channels/protocol-http.ts, which serves SPEC v1 and goes with it.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  type Agent,
  type AgentError,
  AgentRejection,
  type Attachment,
  type ReplayFrom,
  type ResumeEvent,
  agentError,
} from "../agent-api.ts";
import type { ChannelHandler } from "../channel.ts";
import { log } from "../log.ts";
import { abortFirstIterator } from "../sse-client.ts";
import { MAX_BODY_BYTES, readBodyCapped } from "./body.ts";
import { text } from "./respond.ts";
import { assertCorsOrigins, parseRouteKey, router, withoutBody } from "./router.ts";
import { sseResponse } from "./sse.ts";

/** agent-api.md §7.1: each code's status. A code this table does not name is a server fault. */
const STATUS: Record<string, number> = {
  invalid_request: 400,
  not_found: 404,
  busy: 429,
  missing_model: 422,
  auth_required: 422,
  model_error: 502,
  unavailable: 503,
  internal: 500,
};

/** What an attachment may be served as under its own type: a sender-declared `text/html` would run script. */
const RASTER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const json = (value: unknown, status = 200): Response =>
  new Response(`${JSON.stringify(value)}\n`, { status, headers: { "content-type": "application/json" } });

const refused = (error: AgentError): Response => json({ error }, STATUS[error.code] ?? 500);

const invalid = (message: string): Response => refused(agentError("invalid_request", message));

/** A result: its value without `ok` when it succeeded, its error under its code's status when it did not. */
function answer<T extends object>(
  result: ({ ok: true } & T) | { ok: false; error: AgentError } | { ok: false; unknown: object },
  status = 200,
): Response {
  if (result.ok) {
    const { ok: _, ...value } = result;
    return json(value, status);
  }
  return "error" in result ? refused(result.error) : json({ unknown: result.unknown }, 503);
}

/** `getMessage` and `attachment` reject with an `AgentRejection` when the storage cannot answer (§2). */
async function reading<T>(work: () => Promise<T>, respond: (value: T) => Response): Promise<Response> {
  try {
    return respond(await work());
  } catch (error) {
    if (!(error instanceof AgentRejection)) throw error;
    const { code, message, retryable, details } = error;
    return refused({ code, message, retryable, ...(details === undefined ? {} : { details }) });
  }
}

// ── Request bodies ───────────────────────────────────────────────────────────

const Part = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String }),
]);

const InvokeBody = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  content: Schema.Array(Part),
  idempotencyKey: Schema.optionalKey(Schema.String),
  whenBusy: Schema.optionalKey(Schema.Literals(["queue", "steer", "reject"])),
});

const CreateBody = Schema.Struct({
  from: Schema.optionalKey(
    Schema.Struct({
      sessionId: Schema.String,
      entryId: Schema.optionalKey(Schema.String),
      context: Schema.optionalKey(Schema.Literals(["full", "recent"])),
    }),
  ),
  model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, modelId: Schema.String })),
  thinkingLevel: Schema.optionalKey(Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
});

/** The body as the schema says, or the answer that it is not. An empty body is `{}`; an unknown field is refused. */
async function decoded<S extends Schema.Top>(
  req: Request,
  schema: S,
): Promise<{ value: S["Type"] } | { error: Response }> {
  const body = await readBodyCapped(req, MAX_BODY_BYTES);
  if ("tooLarge" in body) return { error: invalid("the body is larger than 1 MiB") };
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

// ── Routing ──────────────────────────────────────────────────────────────────

type Params = Record<string, string>;
type Handler = (req: Request, url: URL, params: Params) => Response | Promise<Response>;

/** A table of `"<METHOD> <path>"`, where a `{name}` segment is a percent-encoded variable. */
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
          // A segment that is not valid percent-encoding names nothing.
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
      log.error(`[agent-api] ${req.method} ${url.pathname} failed: ${error instanceof Error ? error.stack : error}`);
      res = refused(agentError("internal", "the request failed on the server"));
    }
    return req.method === "HEAD" ? withoutBody(res) : res;
  };
}

/** `?limit=` as a non-negative integer; the Agent refuses one above its maximum. */
function limitOf(url: URL): { limit?: number } | { error: Response } {
  const raw = url.searchParams.get("limit");
  if (raw === null) return {};
  return /^\d{1,6}$/.test(raw) ? { limit: Number(raw) } : { error: invalid("limit is a non-negative integer") };
}

const optional = <K extends string>(key: K, value: string | null): { [P in K]?: string } =>
  (value === null ? {} : { [key]: value }) as { [P in K]?: string };

/** Base64 without `Buffer`: this module runs in any Fetch runtime. */
function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function attachmentResponse(attachment: Attachment | undefined): Response {
  if (attachment === undefined) return new Response(null, { status: 404 });
  return new Response(fromBase64(attachment.data), {
    headers: {
      "content-type": RASTER_IMAGE_TYPES.has(attachment.mimeType) ? attachment.mimeType : "application/octet-stream",
      "x-content-type-options": "nosniff",
      // The declared type, for a client that wants it back; never one the browser acts on. Percent-encoded: a sender
      // may declare any string, and a header carries Latin-1 without line breaks.
      "x-mime-type": encodeURIComponent(attachment.mimeType),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

// ── Resuming ─────────────────────────────────────────────────────────────────

/** Where a resume starts: `Last-Event-ID` (a reconnect), else `?replay=start` or `?after=`, else no replay. */
function replayOf(req: Request, url: URL): ReplayFrom | undefined | { error: Response } {
  const lastEventId = req.headers.get("last-event-id");
  if (lastEventId !== null)
    return lastEventId === "start" ? { type: "start" } : { type: "after", entryId: lastEventId };
  const replay = url.searchParams.get("replay");
  const after = url.searchParams.get("after");
  if (replay !== null && after !== null) return { error: invalid("replay and after are one cursor, not two") };
  if (replay !== null) return replay === "start" ? { type: "start" } : { error: invalid("replay is only start") };
  return after === null ? undefined : { type: "after", entryId: after };
}

/**
 * A resume as an event stream whose `state` carries an SSE id: the newest entry when the snapshot was taken, or `start`.
 * The Agent's snapshot names no entry, so a resume asked for no replay is opened after the newest entry a read found, and
 * what it replays up to its snapshot (entries written between the read and the snapshot) is withheld: the Caller asked
 * for none of them, and the last one is the snapshot's id. A refusal before the first event is the error's status.
 */
async function resumeResponse(agent: Agent, sessionId: string, asked: ReplayFrom | undefined): Promise<Response> {
  let replayFrom = asked;
  if (asked === undefined) {
    const newest = await agent.read(sessionId, { limit: 1 });
    if (!newest.ok) return refused(newest.error);
    const entry = newest.entries.at(-1);
    replayFrom = entry === undefined ? { type: "start" } : { type: "after", entryId: entry.id };
  }
  const iterator = agent.resume(sessionId, replayFrom === undefined ? {} : { replayFrom })[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return refused(agentError("internal", "the resume ended before its snapshot"));
  if (first.value.type === "rejected") return refused(first.value.error);
  let cursor = replayFrom?.type === "after" ? replayFrom.entryId : "start";
  let snapshotSent = false;
  const events = (async function* (): AsyncGenerator<{ event: ResumeEvent; id?: string }> {
    for (let next: IteratorResult<ResumeEvent> = first; !next.done; next = await iterator.next()) {
      const event = next.value;
      if (event.type === "entry") {
        cursor = event.entry.id;
        if (!snapshotSent && asked === undefined) continue;
        yield { event, id: cursor };
      } else if (event.type === "state" && !snapshotSent) {
        snapshotSent = true;
        yield { event, id: cursor };
      } else {
        yield { event };
      }
    }
  })();
  // Leaving the stream (the client went away) closes the Agent's resume, releasing what it held (MUST 3).
  const leaving = abortFirstIterator(events, () => void iterator.return?.());
  return sseResponse(
    { [Symbol.asyncIterator]: () => leaving },
    ({ event }) => event,
    ({ id }) => id,
  );
}

// ── The handler ──────────────────────────────────────────────────────────────

/**
 * The Agent API as one Fetch handler. It answers no browser cross-origin unless `corsOrigins` names who may: mounted in
 * an app, who reaches it and from which page is the app's decision.
 */
export function createAgentApiHandler(agent: Agent, options: { corsOrigins?: readonly string[] } = {}): ChannelHandler {
  if (options.corsOrigins) assertCorsOrigins(options.corsOrigins, "createAgentApiHandler: corsOrigins");

  const sessions: Record<string, Handler> = {
    "POST /sessions": async (req) => {
      const body = await decoded(req, CreateBody);
      if ("error" in body) return body.error;
      return answer(await agent.createSession(body.value), 201);
    },
    "GET /sessions/{s}": (_req, url, { s }) => {
      const limit = limitOf(url);
      if ("error" in limit) return limit.error;
      return agent
        .read(s as string, {
          ...optional("after", url.searchParams.get("after")),
          ...optional("before", url.searchParams.get("before")),
          ...limit,
        })
        .then((result) => answer(result));
    },
    "GET /sessions/{s}/events": (req, url, { s }) => {
      const replay = replayOf(req, url);
      if (replay !== undefined && "error" in replay) return replay.error;
      return resumeResponse(agent, s as string, replay);
    },
    "GET /sessions/{s}/messages": (_req, url, { s }) => {
      const idempotencyKey = url.searchParams.get("idempotencyKey");
      if (idempotencyKey === null) return invalid("expected ?idempotencyKey=");
      return reading(
        () => agent.getMessage(s as string, { idempotencyKey }),
        (message) => json(message ?? null),
      );
    },
    "GET /sessions/{s}/messages/{m}": (_req, _url, { s, m }) =>
      reading(
        () => agent.getMessage(s as string, { messageId: m as string }),
        (message) => json(message ?? null),
      ),
    // The request's signal is the Caller's: a client that goes away stops waiting, never the stop (MUST 3).
    "POST /sessions/{s}/abort": async (req, _url, { s }) =>
      answer(await agent.abort(s as string, { signal: req.signal })),
    "GET /sessions/{s}/attachments/{ref}": (_req, _url, { s, ref }) =>
      reading(() => agent.attachment(s as string, ref as string), attachmentResponse),
  };

  const invoke: ChannelHandler = async (req) => {
    const body = await decoded(req, InvokeBody);
    if ("error" in body) return body.error;
    const { content, ...rest } = body.value;
    const result = await agent.invoke({ ...rest, content: content.map((part) => ({ ...part })) });
    if (!result.ok) return answer(result);
    const { ok: _, wait: _wait, ...receipt } = result;
    return json(receipt, 202);
  };

  return router({
    unverified: { "POST /invoke": invoke },
    mounts: [
      { prefix: "/sessions", handler: app(sessions) },
      { prefix: "/agent", handler: app({ "GET /agent": () => json(agent.info()) }) },
    ],
    corsOrigins: options.corsOrigins ?? false,
    // §8: refused as `invalid_request`, an `AgentError` a Caller can read, not the router's plain-text 415.
    notJson: () => invalid("content-type must be application/json"),
  });
}
