/**
 * The session control plane over HTTP + SSE — the Phase 3 transport (design §13). Engine-neutral:
 * consumes only the `SessionControl` contract. One transport serves every remote consumer (Web
 * panel, desktop app, `fastagent attach`); the embedded API stays semantic-only and the ENVELOPE
 * lives here: `id` (request correlation — implicit in HTTP), `epoch` (serving-process incarnation
 * — INFORMATIONAL, for consumers correlating across connections; a restart surfaces as its
 * connections dropping, so no one fences on it), `seq` (per-connection monotonic, detects loss in
 * transit).
 *
 * SECURITY: these routes carry steer/abort/set_model — a remote-control surface. The bearer token
 * is REQUIRED (there is no unauthenticated mode) and is the only auth the framework owns; anything
 * beyond a shared secret (principals, per-permission split, audit) is the wrapping host's job
 * (design §14). Locally the serving process generates a per-boot token and writes it to
 * `<stateRoot>/control.json` for local discovery — filesystem permissions guard the token, and the
 * token guards the routes. That premise is shared-filesystem: a deployment breaks it, so there the
 * DEPLOYER supplies the token ({@link CONTROL_TOKEN_ENV}) and both sides know it. How far those routes REACH is the bind address: all interfaces by
 * default (containers require it), so the port is LAN-reachable and the mount warns accordingly —
 * `--bind 127.0.0.1` (or `http.host`) closes exactly that reach, and the warning goes quiet because
 * there is none left to state.
 */
import type { ImageRef, Prompt } from "../agent.ts";
import {
  INVALID_COMMAND_CODE,
  SESSIONS_UNAVAILABLE_CODE,
  type SessionAction,
  type SessionControl,
  type SessionEvent,
  type SessionUpdate,
  type SessionUpdateField,
} from "../session.ts";
import { timingSafeEqual } from "node:crypto";
import type { Agent } from "../agent.ts";
import type { ChannelHandler } from "../channel.ts";
import { type PrefixMount, parseRouteKey, withoutBody } from "./serve.ts";
import { log } from "../log.ts";
import { readBodyCapped } from "./body.ts";
import { MAX_BODY_BYTES, createInvokeHandler, sseHeartbeat } from "./http.ts";
import { text } from "./respond.ts";

/** The prefix this plane OWNS: everything under it is the plane's to answer. */
const CONTROL_PREFIX = "/control";

/** The one variable segment in this plane's paths: a percent-encoded session id. Written into route
 *  keys so the table reads like the URLs it serves. */
const SESSION_SEGMENT = "{session}";

/** A plane handler: the request, plus the session id the path named (`""` where the path has none). */
type PlaneHandler = (req: Request, session: string) => Response | Promise<Response>;

/** The plane's route table: `"<METHOD> <path>"` → handler, where at most one path segment is
 *  {@link SESSION_SEGMENT}. */
export type PlaneRoutes = Record<string, PlaneHandler>;

/** The token, when the DEPLOYER owns it rather than the box (`mountSessionControl` reads it, `deploy`
 *  carries it). Declared here with the prefix because both are the plane's public names: the serving
 *  side and the deploy side must spell it identically, and a rename that hits only one of them fails
 *  silently — the box mints its own and every caller the runbook told gets a 401. */
export const CONTROL_TOKEN_ENV = "FASTAGENT_CONTROL_TOKEN";

/** The SSE payload: one control-plane event in its transport envelope. */
export interface WireEvent {
  sessionId: string;
  /** Serving-process incarnation (per `createControlPlane` call). A change means the server restarted:
   *  live continuity is gone — run the reconnect steps (entries cursor + state). */
  epoch: string;
  /** Per-connection monotonic counter. A gap means events were lost in transit on THIS connection. */
  seq: number;
  event: SessionEvent;
}

const json = (value: unknown, status = 200): Response =>
  new Response(`${JSON.stringify(value)}\n`, { status, headers: { "content-type": "application/json" } });

/**
 * The plane as one mounted sub-application rather than routes sharing a prefix.
 *
 * CORS belongs to every reply that leaves the plane — including the ones no route produces (an
 * unknown path, an unserved method, a throwing handler). As separate routes those came from the
 * host, outside anything the plane could decorate. Owning the prefix makes them its own answers,
 * headers applied at the single exit they share.
 *
 * `*` is the right origin: authorisation is the bearer token — never the origin, never a cookie —
 * so an origin that cannot present it gets 401 either way, and a deployment cannot know the origins
 * of the GUIs that will manage it (§14's asymmetry).
 *
 * `authorization` is not CORS-safelisted, so EVERY call preflights, including a plain GET.
 * `content-type` is not either (only three values are, and `application/json` is not among them),
 * so a browser POSTing to dispatch/invoke names it — allowing just `authorization` leaves precisely
 * the WRITE routes unreachable while reads work.
 */ function planeApp(routes: PlaneRoutes): ChannelHandler {
  /** A route key's path split into segments, with `{session}` marked. Paths are matched SEGMENT BY
   *  SEGMENT rather than by regex because a session id is an opaque Caller string: percent-encoded
   *  it can contain anything, and `URL.pathname` leaves `%2F` encoded — so splitting on `/` cannot
   *  be fooled by an id that contains one. */
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
          // The one place a path segment becomes a Caller id again. An empty segment is not an id —
          // it would address a session no other call can name.
          if (actual === "") {
            ok = false;
            break;
          }
          try {
            session = decodeURIComponent(actual);
          } catch {
            // `%zz` and friends: not an id any client could have produced, so this path matches
            // nothing and falls through to the plane's own 404. Decoding runs BEFORE the try that
            // guards the handlers, so letting it throw would leave the boundary entirely — no CORS
            // headers, no log line, and a rejected promise for an embedder mounting this handler
            // directly. The query-parameter form this replaced decoded leniently and could not.
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
  // Per PATH, stating what it actually serves — omitting a method it does serve has the browser
  // refuse a call that would have worked. `HEAD` is that case: every GET route answers it.
  const allowMethods = (hits: ReturnType<typeof match>, requested: string | null) => {
    const methods = new Set(hits.flatMap((h) => (h.route.method ? [h.route.method] : [])));
    if (methods.has("GET")) methods.add("HEAD");
    // The requested method is always allowed, even where this path does not serve it: preflight is a
    // gate applied BEFORE the request exists, so refusing there means the real request is never sent
    // and the client sees an opaque network error. Allowing it lets the plane's own 404/405 arrive,
    // with these headers and an explanation.
    if (requested) methods.add(requested.toUpperCase());
    return [...methods, "OPTIONS"].join(", ");
  };

  return async (req) => {
    const path = new URL(req.url).pathname;
    const hits = match(path);
    const answer = async (): Promise<Response> => {
      // A preflight carries no token — that is its purpose — so it is answered before auth, and for
      // ANY path under the prefix: gating it would stop the request the 404 below is waiting for.
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
      // The plane's own totality boundary: a rejecting handler (`commands()` on an unreadable
      // definition) must still answer with the headers; the message stays internal.
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

// ONE constant for every Prompt-bearing wire surface (imported from the invoke channel — the two
// caps cannot drift apart): actions carry Prompts, which may ride base64 images.
const ACTION_BODY_LIMIT = MAX_BODY_BYTES;

/**
 * Parse-don't-validate at the wire: a remote client can send any JSON, and the hub's inner layers
 * trust action shapes (a malformed `steer` would surface as an ENGINE failure misclassified as
 * `run_command_failed`). Returns the typed action, or undefined for anything malformed — which
 * answers protocol-level `invalid_command`, same responsibility as the hub's unknown-type default.
 */
function parseWireAction(raw: unknown): SessionAction | undefined {
  // COMPILE-TIME drift guard, variant level: this switch hand-mirrors the SessionAction union, and a
  // new variant added in session.ts would otherwise compile clean while the wire answers it
  // `invalid_command` — silently breaking local/remote isomorphism. A new variant must break THIS
  // line first, forcing the decision of how the wire carries it.
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
    // Element-level: `images: [42]` reaching the engine would resurface exactly the misclassified
    // failure this parser exists to prevent (ImageRef shape from src/session.ts's Prompt).
    return images === undefined || (Array.isArray(images) && images.every(imageOk));
  };
  // REBUILD, never pass raw through: "typed out" must be construction, not assertion — a passed-
  // through object would carry arbitrary extra keys into the engine.
  const rebuildPrompt = (p: { text: string }): { text: string; images?: { data: string; mimeType: string }[] } => {
    const images = (p as { images?: { data: string; mimeType: string }[] }).images;
    return {
      text: p.text,
      ...(images ? { images: images.map((i) => ({ data: i.data, mimeType: i.mimeType })) } : {}),
    };
  };
  // COMPILE-TIME drift guard: whitelist reconstruction silently strips any field it does not know.
  // A new Prompt field must break THIS line (non-empty Exclude → {} unassignable), not vanish on
  // the wire while the client believes it was sent.
  const _promptDriftGuard: Record<Exclude<keyof Prompt, keyof ReturnType<typeof rebuildPrompt>>, never> = {};
  void _promptDriftGuard;
  // Same guard one level down: the image whitelist ({data, mimeType}) must break when ImageRef
  // grows a field — top-level coverage alone would let element fields vanish silently.
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
 * Parse a PATCH body into a session update. Same discipline as {@link parseWireAction}: rebuilt
 * field by field, so an unknown key is dropped at the wire rather than reaching the hub, and a wrong
 * TYPE is a 400 rather than an engine failure wearing a session error's code.
 */
function parseWireUpdate(raw: unknown): SessionUpdate | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  const fields: SessionUpdateField[] = ["name", "model", "thinkingLevel", "leafEntryId"];
  // COMPILE-TIME drift guard: a field added to SessionUpdate must break THIS line, not silently
  // stop travelling while the client believes it was sent.
  const _updateDriftGuard: Record<SessionUpdateField, true> = {
    name: true,
    model: true,
    thinkingLevel: true,
    leafEntryId: true,
  };
  void _updateDriftGuard;
  const patch: SessionUpdate = {};
  for (const field of fields) {
    const value = c[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return undefined;
    patch[field] = value;
  }
  return patch;
}
export interface ControlPlaneOptions {
  /** Shared bearer secret, required on every route. Never optional: an unauthenticated
   *  remote-control endpoint must not be constructible by omission. */
  token: string;
  /** The DATA plane over the wire: when provided, `POST /control/invoke` mounts the standard
   *  invoke handler behind the same bearer token — a remote client (Web panel, desktop app,
   *  `attach`) can START runs regardless of which channels occupy `/invoke`. Same contract, same
   *  SSE event stream; disconnecting the response cancels the run (SPEC cancellation). */
  agent?: Agent;
}

/**
 * Create the control plane as a mountable prefix owner — a RESTful surface over
 * {@link CONTROL_PREFIX}: sessions are a collection, a session is a resource, its history and event
 * stream are sub-resources, and the things that HAPPEN to a run are posted to `…/actions`.
 * The plane OWNS the prefix: it answers its own 404/405/preflight and puts CORS headers on every
 * reply — see {@link planeApp}.
 */
export function createControlPlane(control: SessionControl, options: ControlPlaneOptions): PrefixMount {
  return mountControlPlane(controlPlaneRoutes(control, options));
}

/** Mount a plane route table as a {@link PrefixMount} — the plane owns a PREFIX, while a route
 *  table is a set of paths, at most one segment of which is a session id. */
export function mountControlPlane(routes: PlaneRoutes): PrefixMount {
  return { prefix: CONTROL_PREFIX, handler: planeApp(routes) };
}

/**
 * The plane's route table. Exported so the conformance sweeps derive their route list from what is
 * actually mounted, rather than from a hand-kept copy that cannot notice a new route.
 *
 * The shape mirrors the contract: a collection, a resource, its sub-resources, and one action
 * endpoint. What a session IS gets `GET`; what a session HAS gets `PATCH` (properties, last-wins);
 * what happens TO a run gets `POST …/actions` (not a property — an event in time). `PUT` on a
 * session id is the fork, and it is a PUT because a fork is idempotent by construction: the id is
 * the caller's, the body says where the history came from, and repeating it changes nothing.
 */
export function controlPlaneRoutes(control: SessionControl, options: ControlPlaneOptions): PlaneRoutes {
  const { token } = options;
  if (!token) throw new Error("createControlPlane: a bearer token is required (empty tokens are not a mode)");
  const epoch = crypto.randomUUID();

  // Timing-safe: the bearer token is this surface's ONLY auth (and the --tunnel warning names it
  // as the sole protection on a public URL) — a plain === would leak byte-by-byte via timing.
  const expected = Buffer.from(`Bearer ${token}`);
  const authed = (req: Request): boolean => {
    const header = Buffer.from(req.headers.get("authorization") ?? "");
    return header.length === expected.length && timingSafeEqual(header, expected);
  };
  const invokeHandler = options.agent ? createInvokeHandler(options.agent) : undefined;
  /** Authenticate, then hand the handler the pieces every route wants: the request, the URL (for
   *  query parameters), and the session the PATH named — `""` on the routes that have no id in
   *  them, which those handlers never read. */
  const guard =
    (handler: (req: Request, url: URL, session: string) => Response | Promise<Response>): PlaneHandler =>
    (req, session) => {
      if (!authed(req)) return text("unauthorized\n", 401);
      return handler(req, new URL(req.url), session);
    };
  /** Read a JSON body under the shared cap. Answers the Response to send on failure, so a route can
   *  `if ("error" in read) return read.error`. */
  const readJson = async (req: Request): Promise<{ value: unknown } | { error: Response }> => {
    const body = await readBodyCapped(req, ACTION_BODY_LIMIT);
    // The 413 names the ceiling: the docs promise images on this plane, and an unexplained
    // rejection would send a client author hunting everywhere but the cap. Derived from the
    // constant — a hardcoded "1 MiB" would lie the day the cap changes.
    if ("tooLarge" in body) {
      return {
        error: text(`body too large (limit ${MAX_BODY_BYTES >> 20} MiB — images count base64-inflated)\n`, 413),
      };
    }
    // An empty body is an empty object: `POST …/actions` always carries one, but `PATCH` with
    // nothing to set is a legal no-op and a client should not have to send `{}` to say so.
    if (body.text.trim() === "") return { value: {} };
    try {
      return { value: JSON.parse(body.text) as unknown };
    } catch {
      return { error: text("invalid JSON\n", 400) };
    }
  };

  return {
    // The DATA plane, at the prefix rather than under a session: its body already carries the scope
    // (SPEC `invoke(scope, prompt)`), so a session in the path would be a second place to say it —
    // and two places to say one thing is a place for them to disagree.
    ...(invokeHandler ? { "POST /control/invoke": guard((req) => invokeHandler(req)) } : {}),

    "GET /control/capabilities": guard(() => json(control.capabilities())),

    "GET /control/commands": guard(async () => json(await control.commands())),

    // The DEPLOYMENT's conversation list — and the one read that may fail: `[]` is what an empty
    // deployment answers, so a store that cannot be enumerated gets a coded non-2xx instead. 503 +
    // the code, because the alternative (#309's lesson) is a client that can only classify a bare
    // 500 as "the endpoint is unreachable" and burns its reconnect budget on a condition
    // reconnecting cannot fix.
    "GET /control/sessions": guard(async () => {
      try {
        return json(await control.sessions.list());
      } catch (error) {
        return json({ code: SESSIONS_UNAVAILABLE_CODE, message: String(error), retryable: true }, 503);
      }
    }),

    // PUT, because a fork is idempotent: this id, holding the history that was at `from`@`at`.
    // Repeating it answers ok and writes nothing; naming an id that holds a different history is a
    // conflict, not an overwrite.
    [`PUT /control/sessions/${SESSION_SEGMENT}`]: guard(async (req, _url, session) => {
      const read = await readJson(req);
      if ("error" in read) return read.error;
      // `JSON.parse("null")` is null, and a body is whatever the client sent: reaching into it
      // unguarded turns a malformed request into a 500 the client cannot act on.
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
      const patch = parseWireUpdate(read.value);
      if (!patch) {
        // Malformed shape = a protocol-level answer, mirrored from the hub's own payload rejections.
        return json({
          ok: false,
          error: { code: INVALID_COMMAND_CODE, message: "malformed update", retryable: false },
        });
      }
      return json(await control.sessions.get(session).update(patch));
    }),

    [`DELETE /control/sessions/${SESSION_SEGMENT}`]: guard(async (_req, _url, session) =>
      json(await control.sessions.get(session).delete()),
    ),

    [`GET /control/sessions/${SESSION_SEGMENT}/entries`]: guard(async (_req, url, session) => {
      const since = url.searchParams.get("since") ?? undefined;
      return json(await control.sessions.get(session).entries(since !== undefined ? { since } : undefined));
    }),

    // The run actions. Not PATCH: none of them SETS anything — they join, queue, stop, or summarize,
    // and the outcome arrives on the event stream rather than in the resource's next read.
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
      // The result rides HTTP 200 either way: `ok: false` is a protocol-level answer (rejected
      // before acceptance), not a transport failure.
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
      const iterator = control.sessions.get(session).events()[Symbol.asyncIterator]();
      // EAGER registration: issue the first pull NOW, before the Response (and thus the client's
      // fetch resolution) exists — hub subscription is registered synchronously inside next(), so
      // "the client saw response headers" implies "events from that moment on will be delivered".
      // Shrinks the subscribe/backfill race to network reordering instead of a full pull cycle.
      let pending: Promise<IteratorResult<SessionEvent>> | undefined = iterator.next();
      // Observed here so a client that disconnects BEFORE the first pull cannot turn a rejecting
      // events iterator (this is the neutral contract face — any implementation may reject) into a
      // process-killing unhandledRejection; awaiting `pending` at pull still surfaces the error.
      pending.catch(() => {});
      let seq = 0;
      let stopHeartbeat = () => {};
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          stopHeartbeat = sseHeartbeat(controller);
        },
        async pull(controller) {
          let next: IteratorResult<SessionEvent>;
          try {
            next = await (pending ?? iterator.next());
          } catch (error) {
            // A rejecting implementation (the neutral contract permits it) must not leak its
            // subscription: an errored stream never gets cancel(), so the unsubscribe and the
            // heartbeat teardown happen HERE.
            stopHeartbeat();
            void iterator.return?.(undefined)?.catch?.(() => {});
            controller.error(error);
            return;
          }
          pending = undefined;
          if (next.done) {
            stopHeartbeat();
            controller.close();
            return;
          }
          const wire: WireEvent = { sessionId: session, epoch, seq: seq++, event: next.value };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(wire)}\n\n`));
        },
        cancel() {
          stopHeartbeat();
          // Same neutral-contract defense as the pull error path: a rejecting return() on client
          // disconnect must not become a process-level unhandledRejection.
          void iterator.return?.(undefined)?.catch?.(() => {});
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }),
  };
}
