import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/protocol.ts";
import { loopPort } from "../src/loop-port.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { FakeStore, fakeLoopHarness } from "./fake-loop-harness.ts";
import { announceControl, reportServing, withRunOverrides } from "../src/cli/serve.ts";
import { mountAgentcore } from "../src/channels/agentcore-service.ts";
import { type MountableAgent, routesFor } from "../src/service.ts";
import { log } from "../src/log.ts";
import { router } from "../src/channels/serve.ts";
import { text } from "../src/channels/respond.ts";
import type { Schedule } from "../src/schedule/schedule.ts";

const agent: Agent = servingAgent(loopPort(fakeLoopHarness(new FakeStore())));
const served = { api: true, control: false };
const none = { api: false, control: false };

describe("serving surface", () => {
  it("can suppress the data plane for AgentCore's publicly forwarded surface", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-surface-"));
    const ordinary = await routesFor(dir, agent, join(dir, ".state"), { planes: served });
    expect(Object.keys(ordinary.unverified)).toContain("POST /invoke");
    expect(ordinary.mounts.map((m) => m.prefix)).toEqual(["/sessions", "/agent"]);

    // The ONE posture that opts out: AgentCore serves the Runtime's `/invocations` contract instead.
    const agentcore = await routesFor(dir, agent, join(dir, ".state"), { planes: none });
    expect(Object.keys(agentcore.unverified)).toEqual(["GET /health"]);
    expect(agentcore.mounts).toEqual([]);
  });

  it("serves the data plane beside a channel, and RESERVES its path against one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-invoke-surface-"));
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "hook.mjs"),
      `export default () => ({ "POST /hook": () => new Response("x") });\n`,
    );
    const beside = await routesFor(dir, agent, join(dir, ".state"), { planes: served });
    // Two tables, never one table plus a list of which keys are ours: that list was a second answer
    // to the same question, and the two answers drifted apart twice.
    expect(Object.keys(beside.unverified).sort()).toEqual(["GET /health", "POST /invoke"]);
    expect(Object.keys(beside.selfVerifying)).toEqual(["POST /hook"]);

    // Reserved like /control/*: silently replacing the one route every client, every doc and the
    // startup line all name is worse than refusing to start. (A fresh dir: an ESM module already
    // imported from a path is cached under it, so rewriting hook.mjs would re-load the old one.)
    const taken = await mkdtemp(join(tmpdir(), "fa-invoke-taken-"));
    await mkdir(join(taken, "channels"));
    await writeFile(
      join(taken, "channels", "mine.mjs"),
      `export default () => ({ "POST /invoke": () => new Response("mine") });\n`,
    );
    await expect(routesFor(taken, agent, join(taken, ".state"), { planes: served })).rejects.toThrow(
      /channel route\(s\) "POST \/invoke" take a path this serve answers on itself \("POST \/invoke"\)/,
    );

    // The message names the CHANNEL's spelling. A channel may write the method-less "/invoke", and an
    // error naming "POST /invoke" sends its author grepping their own file for a string not in it.
    const anyMethod = await mkdtemp(join(tmpdir(), "fa-invoke-anymethod-"));
    await mkdir(join(anyMethod, "channels"));
    await writeFile(
      join(anyMethod, "channels", "any.mjs"),
      `export default () => ({ "/invoke": () => new Response("mine") });\n`,
    );
    await expect(routesFor(anyMethod, agent, join(anyMethod, ".state"), { planes: served })).rejects.toThrow(
      /channel route\(s\) "\/invoke" take a path this serve answers on itself \("POST \/invoke"\)/,
    );
    // …but ONLY where this serve actually answers there: AgentCore serves the Runtime's `/invocations`
    // contract instead, so the same channel is legal on that posture and the refusal would be a lie.
    const onAgentcore = await routesFor(taken, agent, join(taken, ".state"), { planes: none });
    expect(await (await onAgentcore.selfVerifying["POST /invoke"]!(new Request("http://x/invoke"))).text()).toBe(
      "mine",
    );
  });

  it("keeps health and the data plane for a long-connection channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-long-connection-surface-"));
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "socket.mjs"),
      `export default { name: "socket", connect: () => ({ ready: Promise.resolve(), closed: new Promise(() => {}) }) };\n`,
    );
    const surface = await routesFor(dir, agent, join(dir, ".state"), { planes: served });
    expect(Object.keys(surface.unverified).sort()).toEqual(["GET /health", "POST /invoke"]);
    expect(surface.longConnections.map((connection) => connection.name)).toEqual(["socket"]);
    expect(surface.routeChannels).toEqual([]);
    const health = surface.unverified["GET /health"]!;
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
          unverifiedRoutes: ["POST /invoke", "GET /health"],
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

describe("cli: the assembled serving surface", () => {
  it("a channel route inside a plane's prefix is refused, unless that plane is off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-plane-taken-"));
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "mine.mjs"),
      `export default () => ({ "POST /sessions/x": () => new Response("x") });\n`,
    );
    await expect(routesFor(dir, agent, join(dir, ".state"), { planes: served })).rejects.toThrow(
      /inside a path the agent's own API serves/,
    );
    const off = await routesFor(dir, agent, join(dir, ".state"), { planes: none });
    expect(Object.keys(off.selfVerifying)).toEqual(["POST /sessions/x"]);
  });

  it("the planes answer in the surface dev/start hand to serve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-planes-"));
    const surface = await routesFor(dir, agent, join(dir, ".state"), { planes: { api: true, control: true } });
    const handle = router({
      unverified: surface.unverified,
      selfVerifying: surface.selfVerifying,
      mounts: surface.mounts,
    });
    expect((await handle(new Request("http://h/agent"))).status).toBe(200);
    expect((await handle(new Request("http://h/sessions"))).status).toBe(200);
    expect((await handle(new Request("http://h/control/sessions/x", { method: "DELETE" }))).status).toBe(404);
    expect((await handle(new Request("http://h/health"))).status).toBe(200);
  });

  const api = { planes: { api: true, control: false } };
  const both = { planes: { api: true, control: true } };

  it("--no-api withholds the agent's API for ONE run, without touching the definition", async () => {
    // `http.api: false` is the persistent form and travels into a deployed image. The case this flag exists for is
    // `dev --tunnel`: registering a chat channel's webhook publishes the port at a public URL, and would publish an
    // anonymous, fully-tooled API alongside it.
    const opened = { agentDir: "/x" } as unknown as MountableAgent;
    expect(withRunOverrides(opened, {})).toBe(opened); // no flag, nothing changed
    expect(withRunOverrides(opened, { api: false }).http?.api).toBe(false);
    // Only `false` overrides: an absent flag must not beat a definition that said `http.api: false`.
    const configuredOff = { ...opened, http: { api: false } } as MountableAgent;
    expect(withRunOverrides(configuredOff, {}).http?.api).toBe(false);
    expect(withRunOverrides(configuredOff, { api: true }).http?.api).toBe(false);
    const withCors = { ...opened, http: { cors: ["https://app.example.com"] } } as MountableAgent;
    expect(withRunOverrides(withCors, { api: false }).http).toEqual({ api: false, cors: ["https://app.example.com"] });
  });

  it("the cross-origin grant is said at EVERY boot, loopback included", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      announceControl(both, { host: "127.0.0.1", tunnel: false });
      const said = warn.mock.calls.flat().join(" ");
      expect(warn).toHaveBeenCalledTimes(1); // the grant, and nothing about reach
      expect(said).toMatch(/any web page your browser visits can call this serve cross-origin/);
      expect(said).toContain("POST /invoke");
      expect(said).toContain("http.cors");

      warn.mockClear();
      announceControl({ ...both, corsOrigins: ["https://app.example.com"] }, { tunnel: false });
      expect(warn.mock.calls.flat().join(" ")).not.toMatch(/any web page/);
      warn.mockClear();
      announceControl({ ...both, corsOrigins: ["*"] }, { host: "127.0.0.1", tunnel: false });
      expect(warn.mock.calls.flat().join(" ")).toMatch(/any web page/);

      // Nothing of ours answers here (the AgentCore adapter's surface): no grant to describe.
      warn.mockClear();
      announceControl({ planes: none }, { host: "127.0.0.1", tunnel: false });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("announceControl names the reach and what answers: LAN and tunnel are warnings, loopback is not", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const reachLines = () => warn.mock.calls.flat().filter((line) => !String(line).includes("any web page"));
    try {
      announceControl(both, { host: "127.0.0.1", tunnel: false });
      expect(reachLines()).toEqual([]);
      announceControl(both, { host: "192.168.1.5", tunnel: false });
      expect(reachLines().join(" ")).toContain("192.168.1.5 (off this machine)");
      announceControl(both, { tunnel: false });
      expect(reachLines().join(" ")).toContain("binds all interfaces");
      expect(reachLines()).toHaveLength(2);
      announceControl(both, { host: "127.0.0.1", tunnel: true });
      expect(reachLines().join(" ")).toMatch(/--tunnel publishes this port.*NO authentication/s);

      // The user plane alone: every session readable, a channel's direct messages included.
      warn.mockClear();
      announceControl(api, { tunnel: true });
      const apiOnly = reachLines().join(" ");
      expect(apiOnly).toContain("POST /invoke");
      expect(apiOnly).toContain("a channel's direct messages included");
      expect(apiOnly).not.toContain("/control/*");

      warn.mockClear();
      announceControl({ planes: none }, { tunnel: true });
      expect(warn).not.toHaveBeenCalled();
      announceControl({ planes: { api: false, control: true } }, { tunnel: true });
      const controlOnly = reachLines().join(" ");
      expect(controlOnly).toContain("/control/* (rename, reconfigure or delete any session) answers");
      expect(controlOnly).not.toContain("POST /invoke");
    } finally {
      warn.mockRestore();
    }
  });
});
