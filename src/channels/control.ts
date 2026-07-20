/**
 * The session control plane over HTTP + SSE — the Phase 3 transport (design §13). Engine-neutral:
 * consumes only the `SessionControl` contract. One transport serves every remote consumer (Web
 * panel, desktop app, `fastagent attach`); the embedded API stays semantic-only and the ENVELOPE
 * lives here: `id` (request correlation — implicit in HTTP), `epoch` (serving-process incarnation,
 * fences a restart), `seq` (per-connection monotonic, detects loss in transit).
 *
 * SECURITY: these routes carry steer/abort/set_model — a remote-control surface. The bearer token
 * is REQUIRED (there is no unauthenticated mode) and is the only auth the framework owns; anything
 * beyond a shared secret (principals, per-permission split, audit) is the wrapping host's job
 * (design §14). The serving process generates a per-boot token and writes it to
 * `<stateRoot>/control.json` for local discovery — filesystem permissions are the local trust
 * boundary.
 */
import type { SessionControl, SessionEvent } from "../session.ts";
import type { Routes } from "../host/node.ts";
import { readBodyCapped } from "./body.ts";
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

/** SSE comment heartbeat interval — keeps proxies/tunnels from idling out a quiet stream. */
const HEARTBEAT_MS = 30_000;

const DISPATCH_BODY_LIMIT = 256 * 1024; // commands carry prompts; images ride base64 in Prompt

export interface ControlRoutesOptions {
  /** Shared bearer secret, required on every route. Never optional: an unauthenticated
   *  remote-control endpoint must not be constructible by omission. */
  token: string;
}

/**
 * Mount the control plane: `GET /control/capabilities|state|entries|events` + `POST
 * /control/dispatch`, all bearer-authenticated. `events` streams SSE (`data: <WireEvent>` lines).
 */
export function controlRoutes(control: SessionControl, options: ControlRoutesOptions): Routes {
  const { token } = options;
  if (!token) throw new Error("controlRoutes: a bearer token is required (empty tokens are not a mode)");
  const epoch = crypto.randomUUID();

  const authed = (req: Request): boolean => req.headers.get("authorization") === `Bearer ${token}`;
  /** Wrap a handler with auth + the session query param most routes need. */
  const guard =
    (handler: (req: Request, url: URL) => Response | Promise<Response>) =>
    (req: Request): Response | Promise<Response> => {
      if (!authed(req)) return text("unauthorized\n", 401);
      return handler(req, new URL(req.url));
    };
  const requireSession = (url: URL): string | undefined => url.searchParams.get("session") ?? undefined;

  return {
    "GET /control/capabilities": guard(() => json(control.capabilities())),

    "GET /control/state": guard(async (_req, url) => {
      const session = requireSession(url);
      if (!session) return text("missing ?session\n", 400);
      return json(await control.state(session));
    }),

    "GET /control/entries": guard(async (_req, url) => {
      const session = requireSession(url);
      if (!session) return text("missing ?session\n", 400);
      const since = url.searchParams.get("since") ?? undefined;
      return json(await control.entries(session, since !== undefined ? { since } : undefined));
    }),

    "POST /control/dispatch": guard(async (req) => {
      const body = await readBodyCapped(req, DISPATCH_BODY_LIMIT);
      if ("tooLarge" in body) return text("body too large\n", 413);
      let parsed: { session?: unknown; command?: unknown };
      try {
        parsed = JSON.parse(body.text) as typeof parsed;
      } catch {
        return text("invalid JSON\n", 400);
      }
      if (typeof parsed.session !== "string" || typeof parsed.command !== "object" || parsed.command === null) {
        return text("expected { session: string, command: SessionCommand }\n", 400);
      }
      // The result rides HTTP 200 either way: `ok: false` is a protocol-level answer (rejected
      // before acceptance), not a transport failure.
      return json(await control.dispatch(parsed.session, parsed.command as Parameters<typeof control.dispatch>[1]));
    }),

    "GET /control/events": guard((_req, url) => {
      const session = requireSession(url);
      if (!session) return text("missing ?session\n", 400);
      const iterator = control.events(session)[Symbol.asyncIterator]();
      let seq = 0;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              clearInterval(heartbeat);
            }
          }, HEARTBEAT_MS);
        },
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) {
            clearInterval(heartbeat);
            controller.close();
            return;
          }
          const wire: WireEvent = { sessionId: session, epoch, seq: seq++, event: next.value };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(wire)}\n\n`));
        },
        cancel() {
          clearInterval(heartbeat);
          void iterator.return?.(undefined);
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
