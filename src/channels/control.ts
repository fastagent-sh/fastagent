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
import { INVALID_COMMAND_CODE, type SessionCommand, type SessionControl, type SessionEvent } from "../session.ts";
import { timingSafeEqual } from "node:crypto";
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

/** Same cap as the invoke channel (1 MiB): commands carry Prompts, which may ride base64 images —
 *  the two Prompt-bearing wire surfaces reject oversized bodies at the same line. */
const DISPATCH_BODY_LIMIT = 1 << 20;

/**
 * Parse-don't-validate at the wire: a remote client can send any JSON, and the hub's inner layers
 * trust command shapes (a malformed `steer` would surface as an ENGINE failure misclassified as
 * `run_command_failed`). Returns the typed command, or undefined for anything malformed — which
 * answers protocol-level `invalid_command`, same responsibility as the hub's unknown-type default.
 */
function parseWireCommand(raw: unknown): SessionCommand | undefined {
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
    default:
      return undefined;
  }
}

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

  // Timing-safe: the bearer token is this surface's ONLY auth (and the --tunnel warning names it
  // as the sole protection on a public URL) — a plain === would leak byte-by-byte via timing.
  const expected = Buffer.from(`Bearer ${token}`);
  const authed = (req: Request): boolean => {
    const header = Buffer.from(req.headers.get("authorization") ?? "");
    return header.length === expected.length && timingSafeEqual(header, expected);
  };
  /** Wrap a handler with auth + the session query param most routes need. */
  const guard =
    (handler: (req: Request, url: URL) => Response | Promise<Response>) =>
    (req: Request): Response | Promise<Response> => {
      if (!authed(req)) return text("unauthorized\n", 401);
      return handler(req, new URL(req.url));
    };
  // Extraction only — each route still answers its own 400 (the name must not imply enforcement).
  const sessionParam = (url: URL): string | undefined => url.searchParams.get("session") ?? undefined;

  return {
    "GET /control/capabilities": guard(() => json(control.capabilities())),

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
      if ("tooLarge" in body) return text("body too large\n", 413);
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
          let next: IteratorResult<SessionEvent>;
          try {
            next = await (pending ?? iterator.next());
          } catch (error) {
            // A rejecting implementation (the neutral contract permits it) must not leak its
            // subscription: an errored stream never gets cancel(), so the unsubscribe and the
            // heartbeat teardown happen HERE.
            clearInterval(heartbeat);
            void iterator.return?.(undefined)?.catch?.(() => {});
            controller.error(error);
            return;
          }
          pending = undefined;
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
