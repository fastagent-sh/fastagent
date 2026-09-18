import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent.ts";
import { announceControl, reportServing } from "../src/cli/serve.ts";
import { mountAgentcore } from "../src/channels/agentcore-service.ts";
import { mountSessionControl, routesFor } from "../src/service.ts";
import { log } from "../src/log.ts";
import { router } from "../src/channels/serve.ts";
import { text } from "../src/channels/respond.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";

describe("serving surface", () => {
  it("can suppress the data plane for AgentCore's publicly forwarded surface", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-surface-"));
    const ordinary = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {});
    expect(Object.keys(ordinary.routes)).toContain("POST /invoke");

    // The ONE posture that opts out: AgentCore serves the Runtime's `/invocations` contract instead.
    const agentcore = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {
      builtinInvoke: false,
    });
    expect(Object.keys(agentcore.routes)).toEqual(["GET /health"]);
  });

  it("serves the data plane beside a channel, and RESERVES its path against one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-invoke-surface-"));
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "hook.mjs"),
      `export default () => ({ "POST /hook": () => new Response("x") });\n`,
    );
    const beside = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {});
    expect(Object.keys(beside.routes).sort()).toEqual(["GET /health", "POST /hook", "POST /invoke"]);

    // Reserved like /control/*: silently replacing the one route every client, every doc and the
    // startup line all name is worse than refusing to start. (A fresh dir: an ESM module already
    // imported from a path is cached under it, so rewriting hook.mjs would re-load the old one.)
    const taken = await mkdtemp(join(tmpdir(), "fa-invoke-taken-"));
    await mkdir(join(taken, "channels"));
    await writeFile(
      join(taken, "channels", "mine.mjs"),
      `export default () => ({ "POST /invoke": () => new Response("mine") });\n`,
    );
    await expect(routesFor(taken, {} as Agent, join(taken, ".state"), undefined, {})).rejects.toThrow(
      /this serve's own data plane answers there/,
    );
    // …but ONLY where this serve actually answers there: AgentCore serves the Runtime's `/invocations`
    // contract instead, so the same channel is legal on that posture and the refusal would be a lie.
    const onAgentcore = await routesFor(taken, {} as Agent, join(taken, ".state"), undefined, {
      builtinInvoke: false,
    });
    expect(await (await onAgentcore.routes["POST /invoke"]!(new Request("http://x/invoke"))).text()).toBe("mine");
  });

  it("keeps health and the data plane for a long-connection channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-long-connection-surface-"));
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "socket.mjs"),
      `export default { name: "socket", connect: () => ({ ready: Promise.resolve(), closed: new Promise(() => {}) }) };\n`,
    );
    const surface = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {});
    expect(Object.keys(surface.routes).sort()).toEqual(["GET /health", "POST /invoke"]);
    expect(surface.longConnections.map((connection) => connection.name)).toEqual(["socket"]);
    expect(surface.routeChannels).toEqual([]);
    const health = surface.routes["GET /health"]!;
    expect((await health(new Request("http://x/health"))).status).toBe(503);
    surface.setReady(true);
    expect((await health(new Request("http://x/health"))).status).toBe(200);
  });
});

describe("mountAgentcore", () => {
  const agent: Agent = {
    async *invoke() {
      yield { type: "completed" as const };
    },
  };
  const schedule: LoadedSchedule = { name: "job", cron: "0 * * * *", tz: "UTC", prompt: "go" };

  it("mounts the adapter's two paths, and ONLY those — the channels live behind the envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-mount-"));
    const routes = mountAgentcore({
      agent,
      stateRoot: dir,
      schedules: [],
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

  it("binds schedule fires by name — an unknown name 404s through the adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-fire-"));
    // schedule-fire is an INTERNAL kind: without the ingress secret the adapter 403s it before
    // routing (see the adapter's authentication boundary), so the mount must carry it.
    process.env.FASTAGENT_INGRESS_SECRET = "ingress-s3cret";
    const routes = mountAgentcore({ agent, stateRoot: dir, schedules: [schedule], channels: () => ({ routes: {} }) });
    const fire = (name: string): Promise<Response> | Response =>
      routes["POST /invocations"]!(
        new Request("http://x/invocations", {
          method: "POST",
          body: JSON.stringify({
            auth: "ingress-s3cret",
            kind: "schedule-fire",
            name,
            slot: "2026-07-07T10:00:00Z",
          }),
        }),
      );
    expect((await fire("nope")).status).toBe(404);
    const res = await fire("job");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fired: true });
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
          browserRoutes: ["POST /invoke", "GET /health"],
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
  it("the control plane is reachable in the surface dev/start hand to serve", async () => {
    // The gap this closes: mountSessionControl returns routes AND mounts, and a caller forwarding
    // only the routes gets a server where every /control/* request 404s, while the startup line
    // still announces the prefix — an address that answers nothing. Every other test builds the
    // router directly; this one assembles it the way `serve` does, from the CLI's own output.
    const control = { capabilities: () => ({ commands: [], models: [] }) } as never;
    const withControl = mountSessionControl({ "GET /health": () => text("ok\n", 200) }, control);
    const surface = { ...withControl }; // exactly what dev/start spread into ServingSurface
    const handle = router(surface.routes, surface.mounts);
    // 200 from the plane, 404 from its absence.
    expect((await handle(new Request("http://h/control/capabilities"))).status).toBe(200);
    expect((await handle(new Request("http://h/health"))).status).toBe(200);
  });

  /** A serve that mounts the data plane — what most postures look like. */
  const withInvoke = (controlPrefix: string | undefined) => ({
    ...(controlPrefix ? { controlPrefix } : {}),
    browserRoutes: ["POST /invoke", "GET /health"],
  });

  it("announceControl names the reach: LAN and tunnel are warnings, loopback is not", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      announceControl(withInvoke("/control"), { host: "127.0.0.1", tunnel: false });
      expect(warn).not.toHaveBeenCalled(); // loopback is not reachable off this machine

      // A specific non-wildcard bind is reachable as itself, and the warning NAMES that bind —
      // counting alone would stay green if the address rendered as `undefined`.
      announceControl(withInvoke("/control"), { host: "192.168.1.5", tunnel: false });
      expect(warn.mock.calls.flat().join(" ")).toContain("192.168.1.5 (off this machine)");
      announceControl(withInvoke("/control"), { tunnel: false });
      expect(warn.mock.calls.flat().join(" ")).toContain("binds all interfaces");
      expect(warn).toHaveBeenCalledTimes(2);

      // The tunnel takes the port PUBLIC, and nothing authenticates it — the word has to be there.
      announceControl(withInvoke("/control"), { host: "127.0.0.1", tunnel: true });
      expect(warn.mock.calls.flat().join(" ")).toMatch(/--tunnel publishes this port.*NO authentication/s);

      // WITHOUT the control plane the exposure is still real: `POST /invoke` runs a turn on the
      // agent's own tools, and it is on every serve. This used to say nothing at all.
      warn.mockClear();
      announceControl(withInvoke(undefined), { host: "127.0.0.1", tunnel: true }); // the tunnel alone
      announceControl(withInvoke(undefined), { tunnel: false }); // the wildcard bind alone
      const withoutPlane = warn.mock.calls.flat().join(" ");
      expect(warn).toHaveBeenCalledTimes(2); // the tunnel, and the wildcard bind
      expect(withoutPlane).toContain("POST /invoke");
      expect(withoutPlane).not.toContain("/control/*");

      // …and it names only what THIS process serves, from `browserRoutes`. The AgentCore posture
      // answers the Runtime's /invocations behind IAM and mounts no /invoke; `http.invoke: false`
      // withholds it; a channel serving that path answers for itself, behind its own signature
      // check. A warning about an endpoint that is not ours teaches the operator to skim past all.
      warn.mockClear();
      announceControl({ browserRoutes: [] }, { tunnel: true });
      expect(warn).not.toHaveBeenCalled();
      // With the control plane still published, the warning stands — naming only that.
      announceControl({ controlPrefix: "/control", browserRoutes: [] }, { tunnel: true });
      const controlOnly = warn.mock.calls.flat().join(" ");
      expect(controlOnly).toContain("/control/* (read, steer, delete any session) answers");
      expect(controlOnly).not.toContain("POST /invoke");
    } finally {
      warn.mockRestore();
    }
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

  it("the bind chain: flag > http.host > the command's last rung (dev loopback, start wildcard)", async () => {
    // Both commands read ONE chain and differ only in where it ends, so both ends are asserted here: `devBindHost`
    // is dev's whole policy (its call site passes the parsed flag and `http.host` straight through), and start's
    // end is `resolveBindHost` with no fallback.
    const { resolveBindHost } = await import("../src/cli/serve.ts");
    const { devBindHost } = await import("../src/cli/commands/dev.ts");
    expect(devBindHost("192.168.1.5", "0.0.0.0", false)).toBe("192.168.1.5");
    expect(devBindHost(undefined, "0.0.0.0", false)).toBe("0.0.0.0"); // a configured bind beats the default
    expect(devBindHost(undefined, "localhost", false)).toBe("127.0.0.1"); // read as an address
    expect(devBindHost(undefined, undefined, false)).toBe("127.0.0.1"); // dev ends at loopback
    expect(devBindHost(undefined, undefined, true)).toBe("127.0.0.1"); // a bind `localhost` resolves to: --tunnel ok
    expect(resolveBindHost(undefined, undefined, false)).toBeUndefined(); // start: the wildcard a container needs
  });

  it("assertTunnelBindable: --tunnel refuses a bind localhost cannot reach; the source picks the exit code", async () => {
    const { assertTunnelBindable } = await import("../src/cli/serve.ts");
    expect(exits(() => assertTunnelBindable("192.168.1.5", true, "config"))).toBe(1); // startup failure
    expect(exits(() => assertTunnelBindable("192.168.1.5", false, "flag"))).toBeUndefined(); // no tunnel, no conflict
    expect(exits(() => assertTunnelBindable("127.0.0.1", true, "flag"))).toBeUndefined();
    expect(exits(() => assertTunnelBindable("::1", true, "flag"))).toBeUndefined(); // localhost resolves to it
    // Loopback yet NOT what `localhost` resolves to — the tunnel would 502, so it is refused.
    expect(exits(() => assertTunnelBindable("127.0.0.2", true, "flag"))).toBe(2); // a flag combination = usage
    expect(exits(() => assertTunnelBindable(undefined, true, "flag"))).toBeUndefined();
  });

  it("assertTunnelBindable names the SOURCE, not just the exit code", async () => {
    const { assertTunnelBindable } = await import("../src/cli/serve.ts");
    // Same refusal, two audiences: under `config` there is no --bind to change and no flag to drop, so
    // flag-only wording sends the reader hunting for something they never typed.
    const said = (source: "flag" | "config") => {
      const seen: string[] = [];
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);
      const err = vi.spyOn(console, "error").mockImplementation((m: unknown) => void seen.push(String(m)));
      try {
        assertTunnelBindable("192.168.1.5", true, source);
      } catch {
        /* the injected exit */
      } finally {
        err.mockRestore();
        exit.mockRestore();
      }
      return seen.join("\n");
    };
    expect(said("flag")).toMatch(/drop --tunnel/);
    expect(said("flag")).not.toMatch(/http\.host/);
    expect(said("config")).toMatch(/http\.host/); // the file the value actually came from
  });

  it("the ready lines all name the SAME dialable address", async () => {
    // They are one message: the first says where it bound, the second is the command a reader copies.
    // Only the first was updated when --bind landed, so `--bind 192.168.1.5` printed a curl to
    // localhost — the very address that bind stops answering. They come from one function now; this
    // pins the property that made splitting them a bug.
    const { readyAddressLines, bindLine } = await import("../src/cli/serve.ts");
    const { bindAddress } = await import("../src/bind.ts");
    // `localhost` is IN the list on purpose: it is the only accepted input that could put a NAME in
    // these lines, so leaving it out would make the `not.toContain("localhost")` below pass for the
    // reason that it was never tried. It cannot get here — `parseBind`/`http.host` resolve it to an
    // address first (bind.ts `bindAddress`) — and this is what says so.
    for (const host of [undefined, "0.0.0.0", "127.0.0.1", "192.168.1.5", "::1", bindAddress("localhost")]) {
      const [bound, tryLine] = readyAddressLines(host, 8899, true);
      const dial = tryLine!.match(/curl -s (\S+?)\/invoke/)![1]!;
      expect(dial, String(host)).toContain(":8899");
      expect(dial, String(host)).not.toContain("localhost"); // never a name the bind may not answer
      // A wildcard bind IS every interface, so the report says so rather than understating it as one
      // address — but the curl still has to dial something, and loopback is what a wildcard answers.
      expect(bound, String(host)).toContain(host === undefined || host === "0.0.0.0" ? ":8899 (all interfaces)" : dial);
      if (host === "::1") expect(dial).toBe("[::1]:8899"); // URL form, brackets and all
    }
    // Bind line + try-it, nothing else…
    expect(readyAddressLines("127.0.0.1", 1, true)).toHaveLength(2);
    // …and NO try-it when this serve has no `/invoke` of its own (`http.invoke: false`, or a channel
    // holding that path with a protocol of its own). A copyable request that 404s, or that pushes the
    // built-in body at a handler which does not accept it, is worse than no line.
    expect(readyAddressLines("127.0.0.1", 1, false)).toEqual([bindLine("127.0.0.1", 1)]);
  });
});
