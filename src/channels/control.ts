/** The session control plane over HTTP + SSE (docs/design/session-control.md §13). */
import type { ImageRef, Prompt, Agent } from "../agent.ts";
import {
  INVALID_COMMAND_CODE,
  SESSIONS_UNAVAILABLE_CODE,
  type SessionAction,
  type SessionControl,
  type SessionEvent,
  type SessionUpdate,
  UNSUPPORTED_CAPABILITY_CODE,
  UPDATE_FIELDS,
} from "../session.ts";
import type { ChannelHandler } from "../channel.ts";
import { type PrefixMount, parseRouteKey, withoutBody } from "./serve.ts";
import { log } from "../log.ts";
import { readBodyCapped } from "./body.ts";
import { MAX_BODY_BYTES, createInvokeHandler } from "./http.ts";
import { sseResponse } from "./sse.ts";
import { text } from "./respond.ts";
import { secretEquals } from "./secret.ts";

/** The prefix this plane OWNS: everything under it is the plane's to answer. */
const CONTROL_PREFIX = "/control";

/** The one variable segment in this plane's paths: a percent-encoded session id. */
const SESSION_SEGMENT = "{session}";

/** A plane handler: the request, plus the session id the path named (`""` where the path has none). */
type PlaneHandler = (req: Request, session: string) => Response | Promise<Response>;

/**
 * The plane's route table: `"<METHOD> <path>"` → handler, where at most one path segment is {@link SESSION_SEGMENT}.
 */
export type PlaneRoutes = Record<string, PlaneHandler>;

/** The token, when the DEPLOYER owns it rather than the box (`mountSessionControl` reads it, `deploy` carries it). */
export const CONTROL_TOKEN_ENV = "FASTAGENT_CONTROL_TOKEN";

/** The SSE payload: one control-plane event in its transport envelope. */
export interface WireEvent {
  sessionId: string;
  /** Serving-process incarnation (per `createControlPlane` call). */
  epoch: string;
  /** Per-connection monotonic counter. */
  seq: number;
  event: SessionEvent;
}

const json = (value: unknown, status = 200): Response =>
  new Response(`${JSON.stringify(value)}\n`, { status, headers: { "content-type": "application/json" } });

/** The plane as one mounted sub-application rather than routes sharing a prefix. */
function planeApp(routes: PlaneRoutes): ChannelHandler {
  /** A route key's path split into segments, with `{session}` marked. */
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const { method, path } = parseRouteKey(key);
    return { method, path, segments: path.split("/"), handler };
  });
  const match = (path: string): { route: (typeof compiled)[number]; session?: string }[] => {
    const segments = path.split("/");
    const hits: { route: (typeof compiled)[number]; session?: string }[] = [];
    for (const route of compiled) {
      if (route.segments.length !== segments.length) continue;
      let session: string | undefined;
      let ok = true;
      for (const [i, expected] of route.segments.entries()) {
        const actual = segments[i] as string;
        if (expected === SESSION_SEGMENT) {
          // The one place a path segment becomes a Caller id again.
          if (actual === "") {
            ok = false;
            break;
          }
          try {
            session = decodeURIComponent(actual);
          } catch {
            // `%zz` and friends: not an id any client could have produced, so this path matches nothing and falls
            // through to the plane's own 404.
            ok = false;
            break;
          }
        } else if (expected !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push({ route, session });
    }
    return hits;
  };
  // Per PATH, stating what it actually serves — omitting a method it does serve has the browser refuse a call that
  // would have worked.
  const allowMethods = (hits: ReturnType<typeof match>, requested: string | null) => {
    const methods = new Set(hits.flatMap((h) => (h.route.method ? [h.route.method] : [])));
    if (methods.has("GET")) methods.add("HEAD");
    // The requested method is always allowed, even where this path does not serve it.
    if (requested) methods.add(requested.toUpperCase());
    return [...methods, "OPTIONS"].join(", ");
  };

  return async (req) => {
    const path = new URL(req.url).pathname;
    const hits = match(path);
    const answer = async (): Promise<Response> => {
      // A preflight carries no token — that is its purpose.
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      const hit =
        hits.find((h) => h.route.method === req.method) ??
        (req.method === "HEAD" ? hits.find((h) => h.route.method === "GET") : undefined);
      if (hit) return await hit.route.handler(req, hit.session ?? "");
      // 404 vs 405 as in the host router: a client reads 404 as "this serve predates the route".
      if (hits.length > 0) return text("method not allowed\n", 405);
      return text("not found\n", 404);
    };
    let res: Response;
    try {
      // HEAD carries no content, whichever branch answered — including this plane's own 404/405.
      const answered = await answer();
      res = req.method === "HEAD" ? withoutBody(answered) : answered;
    } catch (error) {
      // The plane's own totality boundary: a rejecting handler (`commands()` on an unreadable definition) must still
      // answer with the headers; the message stays internal.
      log.error(`[control] ${req.method} ${path} failed: ${String(error)}`);
      res = text("internal error\n", 500);
    }
    // THE single exit. Every reply above — route, preflight, 404, 405, 500 — leaves through here.
    res.headers.set("access-control-allow-origin", "*");
    res.headers.set("access-control-allow-headers", "authorization, content-type");
    res.headers.set(
      "access-control-allow-methods",
      allowMethods(hits, req.headers.get("access-control-request-method")),
    );
    return res;
  };
}

// ONE constant for every Prompt-bearing wire surface (imported from the invoke channel — the two caps cannot drift
// apart).
const ACTION_BODY_LIMIT = MAX_BODY_BYTES;

/**
 * Parse-don't-validate at the wire: a remote client can send any JSON, and the hub's inner layers trust action shapes
 * (a malformed `steer` would surface as an ENGINE failure misclassified as `run_command_failed`).
 */
function parseWireAction(raw: unknown): SessionAction | undefined {
  // COMPILE-TIME drift guard, variant level: this switch hand-mirrors the SessionAction union, and a new variant
  // added in session.ts would otherwise compile clean while the wire answers it `invalid_command` — silently breaking
  // local/remote isomorphism.
  const _actionDriftGuard: Record<SessionAction["type"], true> = {
    steer: true,
    follow_up: true,
    abort: true,
    compact: true,
  };
  void _actionDriftGuard;
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  const imageOk = (i: unknown): boolean =>
    typeof i === "object" &&
    i !== null &&
    typeof (i as { data?: unknown }).data === "string" &&
    typeof (i as { mimeType?: unknown }).mimeType === "string";
  const promptOk = (p: unknown): p is { text: string } => {
    if (typeof p !== "object" || p === null) return false;
    if (typeof (p as { text?: unknown }).text !== "string") return false;
    const images = (p as { images?: unknown }).images;
    // Element-level: `images: [42]` reaching the engine would resurface exactly the misclassified failure this parser
    // exists to prevent (ImageRef shape from src/session.ts's Prompt).
    return images === undefined || (Array.isArray(images) && images.every(imageOk));
  };
  // REBUILD, never pass raw through: "typed out" must be construction, not assertion — a passed- through object would
  // carry arbitrary extra keys into the engine.
  const rebuildPrompt = (p: { text: string }): { text: string; images?: { data: string; mimeType: string }[] } => {
    const images = (p as { images?: { data: string; mimeType: string }[] }).images;
    return {
      text: p.text,
      ...(images ? { images: images.map((i) => ({ data: i.data, mimeType: i.mimeType })) } : {}),
    };
  };
  // COMPILE-TIME drift guard: whitelist reconstruction silently strips any field it does not know.
  const _promptDriftGuard: Record<Exclude<keyof Prompt, keyof ReturnType<typeof rebuildPrompt>>, never> = {};
  void _promptDriftGuard;
  // Same guard one level down: the image whitelist ({data, mimeType}) must break when ImageRef grows a field.
  const _imageDriftGuard: Record<Exclude<keyof ImageRef, "data" | "mimeType">, never> = {};
  void _imageDriftGuard;
  switch (c.type) {
    case "steer":
    case "follow_up":
      return promptOk(c.prompt) ? ({ type: c.type, prompt: rebuildPrompt(c.prompt) } as SessionAction) : undefined;
    case "abort":
      return { type: "abort" };
    case "compact":
      return c.instructions === undefined || typeof c.instructions === "string"
        ? { type: "compact", instructions: c.instructions as string | undefined }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Parse a PATCH body into a session update — or into the REASON it is not one, because the two reasons are different
 * answers to the client.
 */
function parseWireUpdate(raw: unknown): { patch: SessionUpdate } | { code: string; message: string } {
  if (typeof raw !== "object" || raw === null) {
    return { code: INVALID_COMMAND_CODE, message: "expected an object of session properties" };
  }
  const c = raw as Record<string, unknown>;
  const unknown = Object.keys(c).filter((key) => !(UPDATE_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    return {
      code: UNSUPPORTED_CAPABILITY_CODE,
      message: `update field(s) ${unknown.join(", ")} — capabilities().updatable lists what this serve sets`,
    };
  }
  const patch: SessionUpdate = {};
  // The field list is the CONTRACT's (`UPDATE_FIELDS`), not a copy: a field added to SessionUpdate travels here
  // without anyone remembering to, and one removed cannot linger.
  for (const field of UPDATE_FIELDS) {
    const value = c[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      return { code: INVALID_COMMAND_CODE, message: `${field} must be a string` };
    }
    patch[field] = value;
  }
  return { patch };
}

export interface ControlPlaneOptions {
  /** Shared bearer secret, required on every route. */
  token: string;
  /**
   * The DATA plane over the wire: when provided, `POST /control/invoke` mounts the standard invoke handler behind the
   * same bearer token.
   */
  agent?: Agent;
}

/** Create the control plane as a mountable prefix owner. */
export function createControlPlane(control: SessionControl, options: ControlPlaneOptions): PrefixMount {
  return mountControlPlane(controlPlaneRoutes(control, options));
}

/**
 * Mount a plane route table as a {@link PrefixMount} — the plane owns a PREFIX, while a route table is a set of paths,
 * at most one segment of which is a session id.
 */
export function mountControlPlane(routes: PlaneRoutes): PrefixMount {
  return { prefix: CONTROL_PREFIX, handler: planeApp(routes) };
}

export function controlPlaneRoutes(control: SessionControl, options: ControlPlaneOptions): PlaneRoutes {
  const { token } = options;
  if (!token) throw new Error("createControlPlane: a bearer token is required (empty tokens are not a mode)");
  const epoch = crypto.randomUUID();

  // The bearer token is this surface's ONLY auth (and the --tunnel warning names it as the sole protection on a
  // public URL).
  const expected = `Bearer ${token}`;
  const authed = (req: Request): boolean => secretEquals(req.headers.get("authorization"), expected);
  const invokeHandler = options.agent ? createInvokeHandler(options.agent) : undefined;
  /**
   * Authenticate, then hand the handler the pieces every route wants: the request, the URL (for query parameters), and
   * the session the PATH named.
   */
  const guard =
    (handler: (req: Request, url: URL, session: string) => Response | Promise<Response>): PlaneHandler =>
    (req, session) => {
      if (!authed(req)) return text("unauthorized\n", 401);
      return handler(req, new URL(req.url), session);
    };
  /** Read a JSON body under the shared cap. */
  const readJson = async (req: Request): Promise<{ value: unknown } | { error: Response }> => {
    const body = await readBodyCapped(req, ACTION_BODY_LIMIT);
    // The 413 names the ceiling: the docs promise images on this plane, and an unexplained rejection would send a
    // client author hunting everywhere but the cap.
    if ("tooLarge" in body) {
      return {
        error: text(`body too large (limit ${MAX_BODY_BYTES >> 20} MiB — images count base64-inflated)\n`, 413),
      };
    }
    // An empty body is an empty object: `POST …/actions` always carries one, but `PATCH` with nothing to set is a
    // legal no-op and a client should not have to send `{}` to say so.
    if (body.text.trim() === "") return { value: {} };
    try {
      return { value: JSON.parse(body.text) as unknown };
    } catch {
      return { error: text("invalid JSON\n", 400) };
    }
  };

  return {
    // The DATA plane, at the prefix rather than under a session.
    ...(invokeHandler ? { "POST /control/invoke": guard((req) => invokeHandler(req)) } : {}),

    "GET /control/capabilities": guard(() => json(control.capabilities())),

    "GET /control/commands": guard(async () => json(await control.commands())),

    // The DEPLOYMENT's conversation list — and the one read that may fail.
    "GET /control/sessions": guard(async () => {
      try {
        return json(await control.sessions.list());
      } catch (error) {
        // ONLY a store fault becomes the retryable code.
        const code = (error as { code?: unknown } | null | undefined)?.code;
        if (typeof code !== "string" || !/^E[A-Z]+$/.test(code)) throw error;
        // Logged as well as answered: the catch would otherwise be the one place a store fault is invisible on the
        // server, since it preempts the boundary that does the logging.
        log.error(`[control] GET /control/sessions failed: ${String(error)}`);
        return json({ code: SESSIONS_UNAVAILABLE_CODE, message: String(error), retryable: true }, 503);
      }
    }),

    // PUT, because a fork is idempotent: this id, holding the history that was at `from`@`at`.
    [`PUT /control/sessions/${SESSION_SEGMENT}`]: guard(async (req, _url, session) => {
      const read = await readJson(req);
      if ("error" in read) return read.error;
      // `JSON.parse("null")` is null, and a body is whatever the client sent: reaching into it unguarded turns a
      // malformed request into a 500 the client cannot act on.
      const body = read.value as { from?: unknown; at?: unknown } | null;
      if (typeof body?.from !== "string" || typeof body.at !== "string") {
        return text("expected { from: string, at: string }\n", 400);
      }
      return json(await control.sessions.fork({ from: body.from, at: body.at, into: session }));
    }),

    [`GET /control/sessions/${SESSION_SEGMENT}`]: guard(async (_req, _url, session) =>
      json(await control.sessions.get(session).state()),
    ),

    // PATCH, because these are session PROPERTIES: last-wins, durable, applied by the next turn.
    [`PATCH /control/sessions/${SESSION_SEGMENT}`]: guard(async (req, _url, session) => {
      const read = await readJson(req);
      if ("error" in read) return read.error;
      const parsed = parseWireUpdate(read.value);
      // A protocol-level answer carrying the SAME code the hub would have used.
      if (!("patch" in parsed)) {
        return json({ ok: false, error: { ...parsed, retryable: false } });
      }
      return json(await control.sessions.get(session).update(parsed.patch));
    }),

    [`DELETE /control/sessions/${SESSION_SEGMENT}`]: guard(async (_req, _url, session) =>
      json(await control.sessions.get(session).delete()),
    ),

    [`GET /control/sessions/${SESSION_SEGMENT}/entries`]: guard(async (_req, url, session) => {
      const since = url.searchParams.get("since") ?? undefined;
      return json(await control.sessions.get(session).entries(since !== undefined ? { since } : undefined));
    }),

    // The run actions.
    [`POST /control/sessions/${SESSION_SEGMENT}/actions`]: guard(async (req, _url, session) => {
      const read = await readJson(req);
      if ("error" in read) return read.error;
      const action = parseWireAction(read.value);
      if (!action) {
        return json({
          ok: false,
          error: { code: INVALID_COMMAND_CODE, message: "malformed action", retryable: false },
        });
      }
      const s = control.sessions.get(session);
      // The result rides HTTP 200 either way: `ok: false` is a protocol-level answer (rejected before acceptance),
      // not a transport failure.
      switch (action.type) {
        case "steer":
          return json(await s.steer(action.prompt));
        case "follow_up":
          return json(await s.followUp(action.prompt));
        case "abort":
          return json(await s.abort());
        case "compact":
          return json(await s.compact(action.instructions !== undefined ? { instructions: action.instructions } : {}));
      }
    }),

    [`GET /control/sessions/${SESSION_SEGMENT}/events`]: guard((_req, _url, session) => {
      let seq = 0;
      return sseResponse(
        control.sessions.get(session).events(),
        (event): WireEvent => ({
          sessionId: session,
          epoch,
          seq: seq++,
          event,
        }),
      );
    }),
  };
}
