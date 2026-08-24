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
 * (design §14). The serving process generates a per-boot token and writes it to
 * `<stateRoot>/control.json` for local discovery — filesystem permissions guard the token, and
 * the token guards the routes. How far those routes REACH is the bind address: all interfaces by
 * default (containers require it), so the port is LAN-reachable and the mount warns accordingly —
 * `--bind 127.0.0.1` (or `http.host`) closes exactly that reach, and the warning goes quiet because
 * there is none left to state.
 */
import type { ImageRef, Prompt } from "../agent.ts";
import { INVALID_COMMAND_CODE, type SessionCommand, type SessionControl, type SessionEvent } from "../session.ts";
import { timingSafeEqual } from "node:crypto";
import type { Agent } from "../agent.ts";
import { type Routes, parseRouteKey } from "../host/node.ts";
import { log } from "../log.ts";
import { readBodyCapped } from "./body.ts";
import { MAX_BODY_BYTES, createInvokeHandler, sseHeartbeat } from "./http.ts";
import { text } from "./respond.ts";

/** The SSE payload: one control-plane event in its transport envelope. */
export interface WireEvent {
  sessionId: string;
  /** Serving-process incarnation (per `controlRoutes` call). A change means the server restarted:
   *  live continuity is gone — run the reconnect steps (entries cursor + state). */
  epoch: string;
  /** Per-connection monotonic counter. A gap means events were lost in transit on THIS connection. */
  seq: number;
  event: SessionEvent;
}

const json = (value: unknown, status = 200): Response =>
  new Response(`${JSON.stringify(value)}\n`, { status, headers: { "content-type": "application/json" } });

/**
 * CORS for the whole plane. `*` is the answer rather than a concession: authorisation here is the
 * bearer token — never the origin, never a cookie — so an origin that cannot present it gets 401
 * either way, and a deployment cannot know the origins of the GUIs that will manage it (§14's
 * asymmetry). Without this the plane is unreachable from ANY browser: `authorization` is not
 * CORS-safelisted, so every call preflights, including a plain GET.
 *
 * `content-type` is allowed for the same reason `authorization` is — only three values are
 * safelisted (form-urlencoded, multipart, text/plain) and `application/json` is not one, so a
 * browser POSTing to /control/dispatch or /control/invoke names it in the preflight. Allowing only
 * `authorization` would leave the plane's two WRITE routes unreachable while every GET worked.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
};

/** `methods` is per PATH, not a plane-wide constant: advertising a method a path does not serve
 *  invites the browser to send it, and the host's 405 comes back without these headers — an opaque
 *  network error in place of a method it was told to use. Advertising the truth stops that request
 *  at the browser, with an accurate diagnosis. */
const withCorsHeaders = (res: Response, methods: string): Response => {
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.headers.set(name, value);
  res.headers.set("access-control-allow-methods", methods);
  return res;
};

/**
 * The plane's routes, made reachable from a browser: CORS headers on EVERY response this plane
 * produces — including the 500 a rejecting handler would otherwise leave to the host, whose
 * synthesized reply carries none. Without them a 401, a 400 or a 500 reaches the client as an
 * opaque "network error", hiding the very answer it needs. Plus an unauthenticated `OPTIONS` per
 * path: a preflight carries no token, which is its entire purpose.
 *
 * Paths and their methods are DERIVED from the table, so a route added later is covered without
 * anyone remembering to; `router` does exact matching, so each path needs its own entry.
 */
function browserReachable(routes: Routes): Routes {
  const methodsByPath = new Map<string, Set<string>>();
  for (const key of Object.keys(routes)) {
    const { method, path } = parseRouteKey(key);
    const methods = methodsByPath.get(path) ?? new Set(["OPTIONS"]);
    // A key with no method serves ANY method (host contract), so advertise everything this plane
    // speaks rather than guessing which one the route meant.
    if (method) methods.add(method);
    else for (const m of ["GET", "POST"]) methods.add(m);
    methodsByPath.set(path, methods);
  }
  const allowed = (path: string): string => [...(methodsByPath.get(path) ?? [])].join(", ");

  const wrapped: Routes = {};
  for (const [key, handler] of Object.entries(routes)) {
    const methods = allowed(parseRouteKey(key).path);
    wrapped[key] = async (req) => {
      try {
        return withCorsHeaders(await handler(req), methods);
      } catch (error) {
        // The plane's OWN totality boundary. The host has one too, but its 500 carries no CORS
        // headers, so a rejecting handler (`commands()` on an unreadable definition) would reach a
        // browser as an opaque network error. Logged here because the host's catch no longer sees
        // it, and the message stays internal — same discipline as the host's.
        log.error(`[control] ${key} failed: ${String(error)}`);
        return withCorsHeaders(text("internal error\n", 500), methods);
      }
    };
  }
  for (const path of methodsByPath.keys()) {
    wrapped[`OPTIONS ${path}`] = () => withCorsHeaders(new Response(null, { status: 204 }), allowed(path));
  }
  return wrapped;
}

// ONE constant for every Prompt-bearing wire surface (imported from the invoke channel — the two
// caps cannot drift apart): commands carry Prompts, which may ride base64 images.
const DISPATCH_BODY_LIMIT = MAX_BODY_BYTES;

/**
 * Parse-don't-validate at the wire: a remote client can send any JSON, and the hub's inner layers
 * trust command shapes (a malformed `steer` would surface as an ENGINE failure misclassified as
 * `run_command_failed`). Returns the typed command, or undefined for anything malformed — which
 * answers protocol-level `invalid_command`, same responsibility as the hub's unknown-type default.
 */
function parseWireCommand(raw: unknown): SessionCommand | undefined {
  // COMPILE-TIME drift guard, variant level: this switch hand-mirrors the SessionCommand union,
  // and a new variant added in session.ts would otherwise compile clean while the wire answers it
  // `invalid_command` — silently breaking local/remote isomorphism. A new variant must break THIS
  // line first, forcing the decision of how the wire carries it.
  const _commandDriftGuard: Record<SessionCommand["type"], true> = {
    steer: true,
    follow_up: true,
    abort: true,
    compact: true,
    set_model: true,
    set_thinking: true,
    navigate: true,
  };
  void _commandDriftGuard;
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
  // REBUILD, never pass raw through: "typed command out" must be construction, not assertion — a
  // passed-through object would carry arbitrary extra keys into the engine.
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
      return promptOk(c.prompt) ? ({ type: c.type, prompt: rebuildPrompt(c.prompt) } as SessionCommand) : undefined;
    case "abort":
      return { type: "abort" };
    case "compact":
      return c.instructions === undefined || typeof c.instructions === "string"
        ? { type: "compact", instructions: c.instructions as string | undefined }
        : undefined;
    case "set_model":
      return typeof c.model === "string" ? { type: "set_model", model: c.model } : undefined;
    case "set_thinking":
      return typeof c.level === "string" ? { type: "set_thinking", level: c.level } : undefined;
    case "navigate":
      return typeof c.targetId === "string" ? { type: "navigate", targetId: c.targetId } : undefined;
    default:
      return undefined;
  }
}

export interface ControlRoutesOptions {
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
 * Mount the control plane: `GET /control/capabilities|commands|state|entries|events` + `POST
 * /control/dispatch`, all bearer-authenticated. `events` streams SSE (`data: <WireEvent>` lines).
 * Every path also answers `OPTIONS` without a token, and every response carries CORS headers — see
 * {@link browserReachable}.
 */
export function controlRoutes(control: SessionControl, options: ControlRoutesOptions): Routes {
  const { token } = options;
  if (!token) throw new Error("controlRoutes: a bearer token is required (empty tokens are not a mode)");
  const epoch = crypto.randomUUID();

  // Timing-safe: the bearer token is this surface's ONLY auth (and the --tunnel warning names it
  // as the sole protection on a public URL) — a plain === would leak byte-by-byte via timing.
  const expected = Buffer.from(`Bearer ${token}`);
  const authed = (req: Request): boolean => {
    const header = Buffer.from(req.headers.get("authorization") ?? "");
    return header.length === expected.length && timingSafeEqual(header, expected);
  };
  const invokeHandler = options.agent ? createInvokeHandler(options.agent) : undefined;
  /** Wrap a handler with auth + the session query param most routes need. */
  const guard =
    (handler: (req: Request, url: URL) => Response | Promise<Response>) =>
    (req: Request): Response | Promise<Response> => {
      if (!authed(req)) return text("unauthorized\n", 401);
      return handler(req, new URL(req.url));
    };
  // Extraction only — each route still answers its own 400 (the name must not imply enforcement).
  const sessionParam = (url: URL): string | undefined => url.searchParams.get("session") ?? undefined;

  return browserReachable({
    ...(invokeHandler ? { "POST /control/invoke": guard((req) => invokeHandler(req)) } : {}),
    "GET /control/capabilities": guard(() => json(control.capabilities())),

    "GET /control/commands": guard(async () => json(await control.commands())),

    "GET /control/state": guard(async (_req, url) => {
      const session = sessionParam(url);
      if (!session) return text("missing ?session\n", 400);
      return json(await control.state(session));
    }),

    "GET /control/entries": guard(async (_req, url) => {
      const session = sessionParam(url);
      if (!session) return text("missing ?session\n", 400);
      const since = url.searchParams.get("since") ?? undefined;
      return json(await control.entries(session, since !== undefined ? { since } : undefined));
    }),

    "POST /control/dispatch": guard(async (req) => {
      const body = await readBodyCapped(req, DISPATCH_BODY_LIMIT);
      // The 413 names the ceiling: the docs promise images on this plane, and an unexplained
      // rejection would send a client author hunting everywhere but the cap.
      if ("tooLarge" in body) {
        // Derived from the constant — a hardcoded "1 MiB" would lie the day the cap changes.
        return text(`body too large (limit ${MAX_BODY_BYTES >> 20} MiB — images count base64-inflated)\n`, 413);
      }
      let parsed: { session?: unknown; command?: unknown };
      try {
        parsed = JSON.parse(body.text) as typeof parsed;
      } catch {
        return text("invalid JSON\n", 400);
      }
      if (typeof parsed.session !== "string") {
        return text("expected { session: string, command: SessionCommand }\n", 400);
      }
      const command = parseWireCommand(parsed.command);
      if (!command) {
        // Malformed shape = a protocol-level answer, mirrored from the hub's unknown-type default.
        return json({
          ok: false,
          error: { code: INVALID_COMMAND_CODE, message: "malformed command", retryable: false },
        });
      }
      // The result rides HTTP 200 either way: `ok: false` is a protocol-level answer (rejected
      // before acceptance), not a transport failure.
      return json(await control.dispatch(parsed.session, command));
    }),

    "GET /control/events": guard((_req, url) => {
      const session = sessionParam(url);
      if (!session) return text("missing ?session\n", 400);
      const iterator = control.events(session)[Symbol.asyncIterator]();
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
  });
}
