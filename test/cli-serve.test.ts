import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AnyChannelModule } from "../src/channels/discover.ts";
import { reportServing } from "../src/cli/serve.ts";
import { mountAgentcore } from "../src/channels/agentcore-service.ts";
import { routesFor } from "../src/service.ts";
import { text } from "../src/channels/respond.ts";
import type { Schedule } from "../src/schedule/schedule.ts";
import { scriptedAgent } from "./scripted-agent.ts";
import { scriptedRun } from "./scripted-run.ts";

const agent = scriptedAgent((request) => scriptedRun(request));
const channels = (modules: Record<string, unknown>) => new Map(Object.entries(modules) as [string, AnyChannelModule][]);

describe("serving surface", () => {
  it("serves the channels' routes, with health beside them unless a channel serves it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-surface-"));
    const beside = routesFor(agent, dir, channels({ hook: () => ({ "POST /hook": () => new Response("x") }) }));
    expect(Object.keys(beside.routes).sort()).toEqual(["GET /health", "POST /hook"]);
    const own = routesFor(agent, dir, channels({ probe: () => ({ "/health": () => new Response("mine") }) }));
    expect(await (await own.routes["/health"]!(new Request("http://x/health"))).text()).toBe("mine");
    expect(Object.keys(own.routes)).toEqual(["/health"]);
  });

  it("keeps health for a long-connection channel, 503 until it is ready", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-long-connection-surface-"));
    const surface = routesFor(
      agent,
      dir,
      channels({
        socket: { name: "socket", connect: () => ({ ready: Promise.resolve(), closed: new Promise(() => {}) }) },
      }),
    );
    expect(Object.keys(surface.routes)).toEqual(["GET /health"]);
    expect(surface.longConnections.map((connection) => connection.name)).toEqual(["socket"]);
    expect(surface.routeChannels).toEqual([]);
    const health = surface.routes["GET /health"]!;
    expect((await health(new Request("http://x/health"))).status).toBe(503);
    surface.setReady(true);
    expect((await health(new Request("http://x/health"))).status).toBe(200);
  });
});

describe("mountAgentcore", () => {
  const schedule: Schedule = { name: "job", cron: "0 * * * *", tz: "UTC", prompt: "go" };

  it("mounts the adapter's two paths, and ONLY those — the channels live behind the envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-mount-"));
    const routes = mountAgentcore({
      agent,
      stateRoot: dir,
      schedules: () => [],
      channels: () => ({ routes: { "POST /telegram": () => text("ok\n", 200) } }),
    });
    // The channel is NOT beside them: AgentCore routes only these two into the container, so a
    // channel mounted alongside would be unreachable anyway — and a channel keyed `/invocations`
    // cannot shadow the adapter, because it is dispatched in the envelope's own namespace.
    expect(Object.keys(routes).sort()).toEqual(["GET /ping", "POST /invocations"]);
    expect(await (await routes["GET /ping"]!(new Request("http://x/ping"))).json()).toMatchObject({
      status: "Healthy",
    });
  });

  it("binds schedule fires by name; skips a fire an edit has not reached EventBridge for; a claim fault is a 500", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-fire-"));
    // schedule-fire is an INTERNAL kind: without the ingress secret the adapter 403s it before
    // routing (see the adapter's authentication boundary), so the mount must carry it.
    process.env.FASTAGENT_INGRESS_SECRET = "ingress-s3cret";
    const routes = mountAgentcore({
      agent,
      stateRoot: dir,
      schedules: () => [schedule],
      channels: () => ({ routes: {} }),
    });
    // An instant EventBridge fires for: a grid point of the hourly cron.
    // (a schedule's fire history is claimed by occurrence — schedule/scheduler.ts).
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    let occurrence = hour.toISOString();
    const fire = (name: string): Promise<Response> | Response =>
      routes["POST /invocations"]!(
        new Request("http://x/invocations", {
          method: "POST",
          body: JSON.stringify({ auth: "ingress-s3cret", kind: "schedule-fire", name, occurrence }),
        }),
      );
    // Not errors: EventBridge can fire before an edit reaches it, and a 4xx would have it retry.
    const gone = await fire("nope");
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({ fired: false, skippedReason: "no such schedule any more" });
    const res = await fire("job");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fired: true });
    occurrence = new Date(hour.getTime() + 60_000).toISOString(); // 00:01 is no instant of "0 * * * *"
    expect(await (await fire("job")).json()).toMatchObject({
      fired: false,
      skippedReason: expect.stringMatching(/not an instant of its cron/),
    });
    // A claim-state fault (the state root is a file): a 500 EventBridge retries, and still a mirror.
    const broken = join(dir, "not-a-dir");
    await writeFile(broken, "");
    const failing = mountAgentcore({
      agent,
      stateRoot: broken,
      schedules: () => [schedule],
      channels: () => ({ routes: {} }),
    });
    occurrence = hour.toISOString();
    const failed = await failing["POST /invocations"]!(
      new Request("http://x/invocations", {
        method: "POST",
        body: JSON.stringify({ auth: "ingress-s3cret", kind: "schedule-fire", name: "job", occurrence }),
      }),
    );
    expect(failed.status).toBe(500); // EventBridge retries it: nothing was claimed
    process.env.FASTAGENT_INGRESS_SECRET = undefined;
  });
});

describe("cli: the serving report", () => {
  it("tells the dev supervisor it is ready, with the channels that mounted", () => {
    // The watch supervisor waits for this message to mark a worker as having served; without it a
    // restart loop never learns the previous boot worked, and --tunnel never starts. It has no other
    // observer, which is how it was once deleted with every test still green.
    const sent: unknown[] = [];
    const original = process.send;
    (process as { send?: unknown }).send = (m: unknown) => {
      sent.push(m);
      return true;
    };
    try {
      reportServing(
        {
          routes: { "POST /telegram": () => new Response("x") },
          channels: { routes: ["telegram"], longConnections: ["feishu-ws"] },
        } as never,
        "127.0.0.1",
        8787,
      );
    } finally {
      (process as { send?: unknown }).send = original;
    }
    expect(sent).toEqual([{ type: "ready", port: 8787, routeChannels: ["telegram"] }]);
  });
});

describe("cli: bind address policy", () => {
  /** Both policies end in process.exit — trade it for a throw so the exit CODE is assertable. */
  const exits = (fn: () => void): number | undefined => {
    const spy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fn();
      return undefined;
    } catch (e) {
      // Only the injected exit is an outcome; a real throw is a bug and must not read as "accepted".
      if (spy.mock.calls.length === 0) throw e;
      return spy.mock.calls[0]?.[0] as number | undefined;
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
  };

  it("parseBind: an unbindable value is a usage error (2), a valid one passes through", async () => {
    const { parseBind } = await import("../src/cli/shared.ts");
    expect(parseBind(undefined)).toBeUndefined();
    expect(parseBind("  ")).toBeUndefined(); // "not set", so the config/default chain still applies
    expect(parseBind("127.0.0.1")).toBe("127.0.0.1");
    expect(exits(() => parseBind("banana"))).toBe(2);
  });

  it("assertTunnelBindable: --tunnel refuses a --bind localhost cannot reach, as a usage error", async () => {
    const { assertTunnelBindable } = await import("../src/cli/serve.ts");
    expect(exits(() => assertTunnelBindable("192.168.1.5", true))).toBe(2);
    expect(exits(() => assertTunnelBindable("192.168.1.5", false))).toBeUndefined(); // no tunnel, no conflict
    expect(exits(() => assertTunnelBindable("127.0.0.1", true))).toBeUndefined();
    expect(exits(() => assertTunnelBindable("::1", true))).toBeUndefined(); // localhost resolves to it
    // Loopback yet NOT what `localhost` resolves to — the tunnel would 502, so it is refused.
    expect(exits(() => assertTunnelBindable("127.0.0.2", true))).toBe(2);
    expect(exits(() => assertTunnelBindable(undefined, true))).toBeUndefined(); // start's wildcard
  });

  it("the bind line names a dialable address, never a name the bind may not answer", async () => {
    const { bindLine } = await import("../src/cli/serve.ts");
    const { bindAddress } = await import("../src/bind.ts");
    // `localhost` is IN the list on purpose: it is the only accepted input that could put a NAME in this line. It
    // cannot get here — `parseBind` resolves it to an address first (bind.ts `bindAddress`) — and this says so.
    for (const host of [undefined, "0.0.0.0", "127.0.0.1", "192.168.1.5", "::1", bindAddress("localhost")]) {
      const line = bindLine(host, 8899);
      expect(line, String(host)).toContain(":8899");
      expect(line, String(host)).not.toContain("localhost");
      // A wildcard bind IS every interface, so the report says so rather than understating it as one address.
      if (host === undefined || host === "0.0.0.0") expect(line).toContain(":8899 (all interfaces)");
    }
    expect(bindLine("::1", 8899)).toContain("[::1]:8899"); // URL form, brackets and all
  });
});
