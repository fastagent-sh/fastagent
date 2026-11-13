import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentcoreRoutes, type AgentcoreAdapterOptions, type RouteSurface } from "../../../src/channels/agentcore.ts";
import type { AgentcoreEnvelope, WebhookReply } from "../../../src/channels/agentcore-protocol.ts";
import type { Routes } from "../../../src/channel.ts";

/** The forwarder→runtime shared secret (FASTAGENT_INGRESS_SECRET) in these tests. */
const SECRET = "ingress-s3cret";

interface AdapterOverrides {
  /** A surface, or a factory for one. Production takes only the factory (construction must not run
   *  until the state root is authoritative); the plain value is this fixture's shorthand. */
  channels?: RouteSurface | (() => Promise<RouteSurface> | RouteSurface);
  isBusy?: () => boolean;
  fireSchedule?: (name: string, occurrence: Date) => Promise<Response>;
  ingressSecret?: string;
  onStateReady?: () => void;
  webhooks?: AgentcoreAdapterOptions["webhooks"];
}

const stateRoot = await mkdtemp(join(tmpdir(), "fa-agentcore-adapter-"));

/** A narrowing local: a property access is not narrowed inside the closure below. */
const asFactory = (given: AdapterOverrides["channels"]): (() => Promise<RouteSurface> | RouteSurface) =>
  typeof given === "function" ? given : () => given ?? { routes: {} };

const adapter = (over: AdapterOverrides = {}): Routes =>
  agentcoreRoutes({
    channels: asFactory(over.channels),
    stateRoot,
    isBusy: over.isBusy ?? (() => false),
    // Unused by most cases: a schedule fire is the handler's to answer, which these do not reach.
    fireSchedule: over.fireSchedule ?? (async () => Response.json({ fired: false, skippedReason: "test" })),
    ingressSecret: "ingressSecret" in over ? over.ingressSecret : SECRET,
    onStateReady: over.onStateReady,
    ...(over.webhooks ? { webhooks: over.webhooks } : {}),
  });

const post = (routes: Routes, body: string): Promise<Response> | Response =>
  routes["POST /invocations"]!(new Request("http://x/invocations", { method: "POST", body }));

/** Post as the FORWARDER (authenticated). */
const postEnvelope = (routes: Routes, envelope: AgentcoreEnvelope): Promise<Response> | Response =>
  post(routes, JSON.stringify({ auth: SECRET, ...envelope }));

/** Post as ANY IAM principal holding InvokeAgentRuntime (no shared secret). */
const postUntrusted = (routes: Routes, envelope: AgentcoreEnvelope): Promise<Response> | Response =>
  post(routes, JSON.stringify(envelope));

/** The instant an alarm names: the clock's name for one fire. */
const OCCURRENCE = "2026-07-07T10:00:00Z";

describe("agentcore adapter: webhook envelope", () => {
  it("reconstructs the original request (method/path/QUERY/headers/body) and rides the reply back byte-exact", async () => {
    const seen: { method: string; secret: string | null; body: string; code: string }[] = [];
    const routes = adapter({
      channels: {
        routes: {
          "POST /telegram": async (req) => {
            seen.push({
              method: req.method,
              secret: req.headers.get("x-telegram-bot-api-secret-token"),
              body: await req.text(),
              // A channel reading searchParams must see the forwarder's query string.
              code: new URL(req.url).searchParams.get("code") ?? "(none)",
            });
            return new Response('{"challenge":"pong"}', {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
    });
    const res = await postEnvelope(routes, {
      kind: "webhook",
      method: "POST",
      path: "/telegram",
      query: "code=abc&x=1",
      headers: { "x-telegram-bot-api-secret-token": "s3cret", "content-type": "application/json" },
      bodyB64: Buffer.from('{"update_id":1}').toString("base64"),
    });
    expect(res.status).toBe(200); // transport is ALWAYS 200; the real status rides inside
    const reply = (await res.json()) as WebhookReply;
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/json");
    expect(Buffer.from(reply.bodyB64, "base64").toString()).toBe('{"challenge":"pong"}');
    expect(seen).toEqual([{ method: "POST", secret: "s3cret", body: '{"update_id":1}', code: "abc" }]);
  });
});

describe("agentcore adapter: the authentication boundary", () => {
  it("rejects unauthenticated INTERNAL kinds — InvokeAgentRuntime is an ordinary IAM action, not proof of origin", async () => {
    const fire = vi.fn(async () => Response.json({ fired: true, ms: 1 }));
    const routes = adapter({
      fireSchedule: fire,
      channels: { routes: { "POST /hook": () => new Response("must not run") } },
    });

    for (const envelope of [
      { kind: "schedule-fire", name: "digest", occurrence: OCCURRENCE },
      { kind: "webhook", method: "POST", path: "/hook" },
      { kind: "wake-poke" },
    ] as AgentcoreEnvelope[]) {
      const res = await postUntrusted(routes, envelope);
      expect(res.status).toBe(403);
    }
    expect(fire).not.toHaveBeenCalled();

    // And a WRONG secret is not a secret, whatever its byte length or type.
    for (const auth of ["guessed", "x".repeat(Buffer.byteLength(SECRET)), 123]) {
      const res = await post(routes, JSON.stringify({ auth, kind: "schedule-fire", name: "d" }));
      expect(res.status, String(auth)).toBe(403);
    }
    expect(fire).not.toHaveBeenCalled();
  });
});
