import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent } from "../src/agent.ts";
import {
  type AgentcoreEnvelope,
  UnknownScheduleError,
  type WebhookReply,
  agentcoreRoutes,
} from "../src/channels/agentcore.ts";
import { MAX_ENVELOPE_BYTES, MAX_WEBHOOK_BODY_BYTES } from "../src/channels/agentcore-limits.ts";
import type { StateSync } from "../src/channels/agentcore-state.ts";
import type { Routes } from "../src/channel.ts";
import type { RouteSurface } from "../src/channels/agentcore.ts";
import { readWakeAlarmUrl, rememberWakeAlarmUrl } from "../src/schedule/wake-alarm.ts";
import type { ScheduleFireOutcome } from "../src/schedule/scheduler.ts";

/** A fake agent yielding a scripted stream (the invoke-envelope SSE path). */
function scriptedAgent(events: AgentEvent[] = [{ type: "text", delta: "hi" }, { type: "completed" }]): Agent {
  return {
    async *invoke() {
      for (const e of events) yield e;
    },
  };
}

/** The forwarder→runtime shared secret (FASTAGENT_INGRESS_SECRET) in these tests. */
const SECRET = "ingress-s3cret";

interface AdapterOverrides {
  routes?: RouteSurface | (() => Promise<RouteSurface> | RouteSurface);
  agent?: Agent;
  isBusy?: () => boolean;
  fire?: (name: string, slot: Date) => Promise<ScheduleFireOutcome>;
  stateSync?: StateSync;
  ingressSecret?: string;
  onStateReady?: () => void;
}

/** A StateSync double: records the lifecycle without touching S3 or the disk. */
function fakeStateSync(over: Partial<StateSync> = {}): StateSync & { seen: string[]; saves: () => number } {
  const seen: string[] = [];
  let saves = 0;
  const base: StateSync = {
    use: (u) => seen.push(u.getUrl),
    ready: async () => {},
    save: () => {
      saves += 1;
    },
    configured: () => seen.length > 0,
    flush: async () => {},
    checkpoint: async () => ({ written: seen.length > 0 }),
  };
  return Object.assign(base, over, { seen, saves: () => saves });
}

const stateRoot = await mkdtemp(join(tmpdir(), "fa-agentcore-adapter-"));

const adapter = (over: AdapterOverrides = {}): Routes =>
  agentcoreRoutes({
    routes: over.routes ?? { routes: {} },
    agent: over.agent ?? scriptedAgent(),
    stateRoot,
    isBusy: over.isBusy ?? (() => false),
    fire: over.fire,
    stateSync: over.stateSync,
    ingressSecret: "ingressSecret" in over ? over.ingressSecret : SECRET,
    onStateReady: over.onStateReady,
  });

const post = (routes: Routes, body: string): Promise<Response> | Response =>
  routes["POST /invocations"]!(new Request("http://x/invocations", { method: "POST", body }));

/** Post as the FORWARDER (authenticated). */
const postEnvelope = (routes: Routes, envelope: AgentcoreEnvelope): Promise<Response> | Response =>
  post(routes, JSON.stringify({ auth: SECRET, ...envelope }));

/** Post as ANY IAM principal holding InvokeAgentRuntime (no shared secret). */
const postUntrusted = (routes: Routes, envelope: AgentcoreEnvelope): Promise<Response> | Response =>
  post(routes, JSON.stringify(envelope));

describe("agentcore adapter: lazy channel construction", () => {
  const health: Routes = { "GET /health": () => new Response("ok\n") };
  const stateUrls = { getUrl: "https://s3/get", putUrl: "https://s3/put" };

  it("constructs the channels AFTER the state restore — once — and reuses them across envelopes", async () => {
    const order: string[] = [];
    const sync = fakeStateSync({
      ready: async () => {
        order.push("restore");
      },
    });
    let built = 0;
    const routes = adapter({
      stateSync: sync,
      routes: () => {
        order.push("construct");
        built += 1;
        return { routes: health };
      },
    });
    expect(built).toBe(0); // never at boot — the mount is pre-restore there
    const env: AgentcoreEnvelope = { kind: "webhook", method: "GET", path: "/health", state: stateUrls };
    const first = await postEnvelope(routes, env);
    expect(first.status).toBe(200);
    expect(((await first.json()) as WebhookReply).status).toBe(200);
    expect(order).toEqual(["restore", "construct"]); // construction strictly after ready()
    await postEnvelope(routes, env);
    expect(built).toBe(1); // memoized — the same resident channels a direct host keeps
  });

  it("a failed construction 503s EVERY envelope with the same message — one activation per process", async () => {
    // Construction is an ACTIVATION with side effects (loadChannels builds every healthy channel —
    // replaying its durable turn intent — before reporting another module's failure) and has no
    // cleanup contract, so the rejection is CACHED: a retry per envelope would re-run the healthy
    // channels' recovery concurrently. The factory must run exactly once, however many envelopes
    // (and 3s-apart deploy probes) follow; a fresh session is the retry boundary.
    let attempts = 0;
    const routes = adapter({
      routes: () => {
        attempts += 1;
        throw new Error("FEISHU_APP_SECRET is not set");
      },
    });
    const env: AgentcoreEnvelope = { kind: "webhook", method: "GET", path: "/health" };
    const failed = await postEnvelope(routes, env);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain("FEISHU_APP_SECRET"); // named, never a silently-empty channel
    const second = await postEnvelope(routes, env);
    expect(second.status).toBe(503);
    expect(await second.text()).toContain("FEISHU_APP_SECRET"); // visible every time, not one 503 then silence
    expect(attempts).toBe(1); // the healthy channels' side effects ran once, not per envelope
  });

  it("a probe reports construction structurally over transport-200 (diagnostics must survive the forwarder)", async () => {
    const ok = adapter({ routes: () => ({ routes: health }) });
    const okRes = await postEnvelope(ok, { kind: "probe" });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ ok: true });

    // The forwarder rewrites any non-200 transport into an opaque 502, so the failure verdict MUST
    // ride a transport-200 body — that is the whole reason the probe kind exists.
    const broken = adapter({
      routes: () => {
        throw new Error("FEISHU_APP_SECRET is not set");
      },
    });
    const res = await postEnvelope(broken, { kind: "probe" });
    expect(res.status).toBe(200);
    const verdict = (await res.json()) as { ok: boolean; error?: string };
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("FEISHU_APP_SECRET");
  });

  it("a probe reports a FAILED RESTORE structurally too, and an unauthenticated probe is refused", async () => {
    const sync = fakeStateSync({
      ready: async () => {
        throw new Error("snapshot GET failed: 403");
      },
    });
    const routes = adapter({ stateSync: sync, routes: () => ({ routes: health }) });
    const res = await postEnvelope(routes, {
      kind: "probe",
      state: { getUrl: "https://s3/g", putUrl: "https://s3/p" },
    });
    expect(res.status).toBe(200); // structured — not the plain 503 other kinds get
    const verdict = (await res.json()) as { ok: boolean; error?: string };
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("state restore failed");

    expect((await postUntrusted(adapter({ routes: () => ({ routes: health }) }), { kind: "probe" })).status).toBe(403);
  });

  it("a schedule fire initializes the channels first, and a broken channel does NOT silence the clock", async () => {
    const order: string[] = [];
    const fire = vi.fn(async (): Promise<ScheduleFireOutcome> => {
      order.push("fire");
      return { fired: true, ms: 5 };
    });
    const routes = adapter({
      fire,
      routes: () => {
        order.push("construct");
        return { routes: health };
      },
    });
    const env: AgentcoreEnvelope = { kind: "schedule-fire", name: "job", slot: "2026-07-07T10:00:00Z" };
    expect((await postEnvelope(routes, env)).status).toBe(200);
    expect(order).toEqual(["construct", "fire"]); // cold start woken by cron still replays turn intent

    // Construction failure: logged, but the fire still runs — cron does not consume channels, and an
    // unrelated channel misconfiguration must not turn one fault into two.
    const fire2 = vi.fn(async (): Promise<ScheduleFireOutcome> => ({ fired: true, ms: 5 }));
    const broken = adapter({
      fire: fire2,
      routes: () => {
        throw new Error("channels/lark.ts is broken");
      },
    });
    expect((await postEnvelope(broken, env)).status).toBe(200);
    expect(fire2).toHaveBeenCalledTimes(1);
  });

  it("a wake-poke resolves construction too (the deploy probe; alarm wakes replay checkpointed turns)", async () => {
    let built = 0;
    const routes = adapter({
      routes: () => {
        built += 1;
        return { routes: {} };
      },
    });
    expect((await postEnvelope(routes, { kind: "wake-poke" })).status).toBe(200);
    expect(built).toBe(1);

    const broken = adapter({
      routes: () => {
        throw new Error("channels/lark.ts is broken");
      },
    });
    const res = await postEnvelope(broken, { kind: "wake-poke" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("channels/lark.ts is broken");
  });
});

describe("agentcore adapter: /ping", () => {
  it("reports Healthy when idle and HealthyBusy while background work is in flight", async () => {
    let busy = false;
    const routes = adapter({ isBusy: () => busy });
    const ping = routes["GET /ping"]!;
    expect(await (await ping(new Request("http://x/ping"))).json()).toMatchObject({ status: "Healthy" });
    busy = true;
    expect(await (await ping(new Request("http://x/ping"))).json()).toMatchObject({ status: "HealthyBusy" });
  });

  it("always carries time_of_last_update, updated ONLY on a real status transition", async () => {
    // The platform's idle measurement reads ONLY this field (measured live: with it omitted, a
    // session answering HealthyBusy every ~2s was still reclaimed mid-turn at exactly the idle
    // timeout after the last invocation — the documented "the platform tracks status changes on
    // its own" omission path is not implemented). A value advancing on EVERY ping is the opposite
    // failure: a perpetual "status change" that never lets idle fire, so sessions live to
    // MaxLifetime and exhaust the quota. Required shape: always present, frozen between transitions.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T06:37:00Z"));
      let busy = false;
      const routes = adapter({ isBusy: () => busy });
      const ping = async () => {
        const res = await routes["GET /ping"]!(new Request("http://x/ping"));
        return (await res.json()) as { status: string; time_of_last_update: number };
      };

      const idle1 = await ping();
      expect(typeof idle1.time_of_last_update).toBe("number");

      vi.advanceTimersByTime(10_000); // pings keep coming while nothing changes
      const idle2 = await ping();
      expect(idle2.time_of_last_update).toBe(idle1.time_of_last_update); // frozen — not "now"

      busy = true; // a turn starts
      vi.advanceTimersByTime(5_000);
      const busy1 = await ping();
      expect(busy1.status).toBe("HealthyBusy");
      expect(busy1.time_of_last_update).toBe(idle1.time_of_last_update + 15); // stamped at the flip

      vi.advanceTimersByTime(120_000); // a long turn: well past a 60s idle timeout
      const busy2 = await ping();
      expect(busy2.time_of_last_update).toBe(busy1.time_of_last_update); // still frozen mid-turn

      busy = false; // turn settles
      vi.advanceTimersByTime(2_000);
      const settled = await ping();
      expect(settled.status).toBe("Healthy");
      expect(settled.time_of_last_update).toBe(busy2.time_of_last_update + 122); // re-stamped once
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("agentcore adapter: webhook envelope", () => {
  it("reconstructs the original request (method/path/headers/body) and rides the reply back byte-exact", async () => {
    const seen: { method: string; secret: string | null; body: string }[] = [];
    const routes = adapter({
      routes: {
        routes: {
          "POST /telegram": async (req) => {
            seen.push({
              method: req.method,
              secret: req.headers.get("x-telegram-bot-api-secret-token"),
              body: await req.text(),
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
      headers: { "x-telegram-bot-api-secret-token": "s3cret", "content-type": "application/json" },
      bodyB64: Buffer.from('{"update_id":1}').toString("base64"),
    });
    expect(res.status).toBe(200); // transport is ALWAYS 200; the real status rides inside
    const reply = (await res.json()) as WebhookReply;
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/json");
    expect(Buffer.from(reply.bodyB64, "base64").toString()).toBe('{"challenge":"pong"}');
    expect(seen).toEqual([{ method: "POST", secret: "s3cret", body: '{"update_id":1}' }]);
  });

  it("enforces the original webhook-body limit even if a caller bypasses the public forwarder", async () => {
    const routes = adapter({ routes: { routes: { "POST /hook": () => new Response("must not run") } } });
    const res = await postEnvelope(routes, {
      kind: "webhook",
      method: "POST",
      path: "/hook",
      bodyB64: Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1).toString("base64"),
    });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as WebhookReply;
    expect(reply.status).toBe(413);
  });

  it("carries a non-2xx channel response inside the envelope (transport stays 200)", async () => {
    const routes = adapter({
      routes: { routes: { "POST /telegram": () => new Response("forbidden\n", { status: 403 }) } },
    });
    const res = await postEnvelope(routes, { kind: "webhook", method: "POST", path: "/telegram" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WebhookReply).status).toBe(403);
  });

  it("an unrouted path rides back as a 404 reply", async () => {
    const res = await postEnvelope(adapter(), { kind: "webhook", method: "POST", path: "/nope" });
    expect(((await res.json()) as WebhookReply).status).toBe(404);
  });

  it("rejects a relative path", async () => {
    const res = await postEnvelope(adapter(), { kind: "webhook", method: "POST", path: "telegram" });
    expect(res.status).toBe(400);
  });

  it("the query string survives the round trip (a channel reading searchParams sees it)", async () => {
    const seen: string[] = [];
    const routes = adapter({
      routes: {
        routes: {
          "GET /hook": (req) => {
            seen.push(new URL(req.url).searchParams.get("code") ?? "(none)");
            return new Response("ok", { status: 200 });
          },
        },
      },
    });
    await postEnvelope(routes, { kind: "webhook", method: "GET", path: "/hook", query: "code=abc&x=1" });
    expect(seen).toEqual(["abc"]);
  });
});

describe("agentcore adapter: schedule-fire envelope", () => {
  const fireEnvelope: AgentcoreEnvelope = { kind: "schedule-fire", name: "job", slot: "2026-07-07T10:00:00Z" };

  it("dispatches to the fire binding with the parsed slot and returns its outcome", async () => {
    const fired: { name: string; slot: string }[] = [];
    const routes = adapter({
      fire: async (name, slot) => {
        fired.push({ name, slot: slot.toISOString() });
        return { fired: true, ms: 5 };
      },
    });
    const res = await postEnvelope(routes, fireEnvelope);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fired: true, ms: 5 });
    expect(fired).toEqual([{ name: "job", slot: "2026-07-07T10:00:00.000Z" }]);
  });

  it("404s when the deployment has no schedules (deploy drift stays visible)", async () => {
    const res = await postEnvelope(adapter(), fireEnvelope);
    expect(res.status).toBe(404);
  });

  it("404s an unknown schedule name (UnknownScheduleError from the binding)", async () => {
    const routes = adapter({
      fire: async (name) => {
        throw new UnknownScheduleError(name);
      },
    });
    const res = await postEnvelope(routes, fireEnvelope);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('unknown schedule "job"');
  });

  it("500s a claim-state fault (fail visibly in the clock's logs)", async () => {
    const routes = adapter({
      fire: async () => {
        throw new Error("fires.json unreadable");
      },
    });
    const res = await postEnvelope(routes, fireEnvelope);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("fires.json unreadable");
  });

  it("a running schedule turn counts as in-flight work (/ping must hold the session)", async () => {
    const { activeWork } = await import("../src/channels/busy.ts");
    const base = activeWork();
    let release: (o: ScheduleFireOutcome) => void = () => {};
    const routes = adapter({ fire: () => new Promise<ScheduleFireOutcome>((r) => (release = r)) });
    const pending = postEnvelope(routes, fireEnvelope) as Promise<Response>;
    await vi.waitFor(() => expect(activeWork()).toBe(base + 1));
    release({ fired: true, ms: 1 });
    await pending;
    expect(activeWork()).toBe(base);
  });

  it("rejects a malformed slot", async () => {
    const res = await postEnvelope(adapter({ fire: async () => ({ fired: true, ms: 0 }) }), {
      kind: "schedule-fire",
      name: "job",
      slot: "not-a-date",
    });
    expect(res.status).toBe(400);
  });
});

describe("agentcore adapter: wake-poke envelope + wake-url capture", () => {
  it("acks a wake-poke (the invocation itself is the payload)", async () => {
    const res = await postEnvelope(adapter(), { kind: "wake-poke" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("persists the forwarder URL ridden on an envelope for the wake-alarm sink", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-wake-url-"));
    const routes = agentcoreRoutes({
      routes: { routes: {} },
      agent: scriptedAgent(),
      stateRoot: root,
      isBusy: () => false,
      ingressSecret: SECRET,
    });
    await routes["POST /invocations"]!(
      new Request("http://x/invocations", {
        method: "POST",
        body: JSON.stringify({ auth: SECRET, kind: "wake-poke", wake: { url: "https://fn.lambda-url.on.aws/" } }),
      }),
    );
    expect(readWakeAlarmUrl(root)).toBe("https://fn.lambda-url.on.aws/");
  });
});

describe("agentcore adapter: invoke envelope", () => {
  it("streams the invoke back as SSE", async () => {
    const routes = adapter({ agent: scriptedAgent([{ type: "text", delta: "hello" }, { type: "completed" }]) });
    const res = await postEnvelope(routes, { kind: "invoke", session: "s".repeat(33), text: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain('data: {"type":"text","delta":"hello"}');
    expect(body).toContain('data: {"type":"completed"}');
  });
});

describe("agentcore adapter: envelope validation", () => {
  it("rejects invalid json / a missing kind / an unknown kind", async () => {
    const routes = adapter();
    const auth = `"auth":"${SECRET}",`;
    expect((await post(routes, "{nope")).status).toBe(400);
    expect((await post(routes, `{${auth}"no":"kind"}`)).status).toBe(400);
    expect((await post(routes, `{${auth}"kind":"mystery"}`)).status).toBe(400);
    // An unknown kind from an UNAUTHENTICATED caller is 403, not 400: the boundary runs first and the
    // public plane is not told which kinds exist.
    expect((await post(routes, '{"kind":"mystery"}')).status).toBe(403);
  });

  it("caps the envelope body", async () => {
    const routes = adapter();
    const huge = JSON.stringify({
      kind: "webhook",
      method: "POST",
      path: "/x",
      bodyB64: "A".repeat(MAX_ENVELOPE_BYTES),
    });
    expect((await post(routes, huge)).status).toBe(413);
  });
});

describe("agentcore adapter: cross-deploy state", () => {
  const withState = (envelope: AgentcoreEnvelope): AgentcoreEnvelope => ({
    ...envelope,
    state: { getUrl: "https://s3/get", putUrl: "https://s3/put" },
  });

  it("adopts the envelope's URLs and restores BEFORE the request is served", async () => {
    const order: string[] = [];
    const sync = fakeStateSync({
      ready: async () => {
        order.push("restore");
      },
    });
    const routes = adapter({
      stateSync: sync,
      routes: {
        routes: {
          "POST /hook": () => {
            order.push("dispatch");
            return new Response("ok");
          },
        },
      },
    });

    await postEnvelope(routes, withState({ kind: "webhook", method: "POST", path: "/hook" }));

    expect(sync.seen).toEqual(["https://s3/get"]);
    expect(order).toEqual(["restore", "dispatch"]); // never serve from an unrestored state root
  });

  it("a failed restore 503s instead of serving an EMPTY agent (which would then snapshot that emptiness)", async () => {
    const routes = adapter({
      stateSync: fakeStateSync({
        ready: async () => {
          throw new Error("snapshot GET failed: 500");
        },
      }),
      routes: {
        routes: {
          "POST /hook": () => new Response("must not run"),
        },
      },
    });

    const res = await postEnvelope(routes, withState({ kind: "webhook", method: "POST", path: "/hook" }));

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("snapshot GET failed: 500");
  });

  it("snapshots when the envelope leaves nothing in flight, and defers to the idle edge when it does", async () => {
    const idle = fakeStateSync();
    await postEnvelope(adapter({ stateSync: idle, isBusy: () => false }), withState({ kind: "wake-poke" }));
    expect(idle.saves()).toBe(1);

    // Busy = a background turn is still writing; the 0-in-flight edge (busy.ts onIdle) owns that save.
    const busy = fakeStateSync();
    await postEnvelope(adapter({ stateSync: busy, isBusy: () => true }), withState({ kind: "wake-poke" }));
    expect(busy.saves()).toBe(0);
  });

  it("a direct invoke carries no URLs — its isolated session must not read or clobber the snapshot", async () => {
    const sync = fakeStateSync();
    const res = await postEnvelope(adapter({ stateSync: sync }), { kind: "invoke", session: "cli", text: "hi" });
    expect(res.status).toBe(200);
    expect(sync.seen).toEqual([]);
  });
});

describe("agentcore adapter: the authentication boundary", () => {
  it("rejects unauthenticated INTERNAL kinds — InvokeAgentRuntime is an ordinary IAM action, not proof of origin", async () => {
    const fire = vi.fn(async () => ({ fired: true, ms: 1 }) as ScheduleFireOutcome);
    const routes = adapter({ fire, routes: { routes: { "POST /hook": () => new Response("must not run") } } });

    for (const envelope of [
      { kind: "schedule-fire", name: "digest", slot: "2026-07-28T09:00:00Z" },
      { kind: "webhook", method: "POST", path: "/hook" },
      { kind: "wake-poke" },
    ] as AgentcoreEnvelope[]) {
      const res = await postUntrusted(routes, envelope);
      expect(res.status).toBe(403);
    }
    expect(fire).not.toHaveBeenCalled();
  });

  it("a WRONG secret is not a secret, regardless of its byte length or type", async () => {
    const routes = adapter({ fire: async () => ({ fired: true, ms: 1 }) as ScheduleFireOutcome });
    for (const auth of ["guessed", "x".repeat(Buffer.byteLength(SECRET)), 123]) {
      const res = await post(
        routes,
        JSON.stringify({ auth, kind: "schedule-fire", name: "d", slot: "2026-07-28T09:00:00Z" }),
      );
      expect(res.status).toBe(403);
    }
  });

  it("public invoke still works, but its internal fields are DROPPED (no snapshot or alarm redirect)", async () => {
    const sync = fakeStateSync();
    const routes = adapter({ stateSync: sync });

    const res = await postUntrusted(routes, {
      kind: "invoke",
      session: "cli",
      text: "hi",
      // An attacker's addresses: exfiltrate the state snapshot / capture the wake secret.
      state: { getUrl: "https://attacker/get", putUrl: "https://attacker/put" },
      wake: { url: "https://attacker/" },
    } as AgentcoreEnvelope);

    expect(res.status).toBe(200); // the public data plane keeps working
    expect(sync.seen).toEqual([]); // …but never adopted the caller's URLs
    expect(readWakeAlarmUrl(stateRoot)).not.toBe("https://attacker/");
  });

  it("with no ingress secret configured (invoke-only topology) nothing internal is servable", async () => {
    const routes = adapter({ ingressSecret: undefined });
    expect((await postEnvelope(routes, { kind: "wake-poke" })).status).toBe(403);
    expect((await postEnvelope(routes, { kind: "invoke", session: "s", text: "hi" })).status).toBe(200);
  });
});

describe("agentcore adapter: post-restore hooks", () => {
  it("runs onStateReady ONCE, after the restore — a boot-time reconcile would see the wiped mount", async () => {
    const order: string[] = [];
    const sync = fakeStateSync({
      ready: async () => {
        order.push("restore");
      },
    });
    const onStateReady = () => order.push("reconcile");
    const routes = adapter({ stateSync: sync, onStateReady });

    await postEnvelope(routes, { kind: "wake-poke", state: { getUrl: "g", putUrl: "p" } });
    await postEnvelope(routes, { kind: "wake-poke", state: { getUrl: "g", putUrl: "p" } });

    expect(order.filter((step) => step === "reconcile")).toEqual(["reconcile"]); // exactly once
    expect(order[0]).toBe("restore"); // …and never before the state root is authoritative
  });

  it("adopts the CURRENT envelope's wake URL after restore — a stale snapshot copy must not win", async () => {
    const routes = adapter({
      stateSync: fakeStateSync({
        ready: async () => {
          // The snapshot restores an older deployment's URL…
          rememberWakeAlarmUrl(stateRoot, "https://old-deployment.lambda-url.on.aws/");
        },
      }),
    });

    await postEnvelope(routes, {
      kind: "wake-poke",
      state: { getUrl: "g", putUrl: "p" },
      wake: { url: "https://current.lambda-url.on.aws/" },
    });

    expect(readWakeAlarmUrl(stateRoot)).toBe("https://current.lambda-url.on.aws/");
  });
});

describe("agentcore adapter: the pre-stop checkpoint", () => {
  it("returns what actually happened, so the deploy log cannot claim a protection it did not give", async () => {
    const wrote = fakeStateSync({ checkpoint: async () => ({ written: true }) });
    const res = await postEnvelope(adapter({ stateSync: wrote }), { kind: "checkpoint" });
    expect(await res.json()).toEqual({ written: true });

    const nothing = fakeStateSync({
      checkpoint: async () => ({ written: false, reason: "this session has never served a forwarder envelope" }),
    });
    const res2 = await postEnvelope(adapter({ stateSync: nothing }), { kind: "checkpoint" });
    expect(await res2.json()).toMatchObject({ written: false, reason: expect.stringContaining("forwarder") });
  });

  it("a failed flush is a 500 — the deploy is about to destroy this process", async () => {
    const res = await postEnvelope(
      adapter({
        stateSync: fakeStateSync({
          checkpoint: async () => {
            throw new Error("snapshot PUT failed: 403");
          },
        }),
      }),
      { kind: "checkpoint" },
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("403");
  });

  it("is an INTERNAL kind — an unauthenticated caller cannot force a snapshot write", async () => {
    const res = await postUntrusted(adapter({ stateSync: fakeStateSync() }), { kind: "checkpoint" });
    expect(res.status).toBe(403);
  });
});
