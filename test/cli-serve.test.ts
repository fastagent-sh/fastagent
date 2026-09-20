import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent.ts";
import { announceControl, reportServing, withRunOverrides } from "../src/cli/serve.ts";
import { mountAgentcore } from "../src/channels/agentcore-service.ts";
import { type MountableAgent, mountSessionControl, routesFor } from "../src/service.ts";
import { log } from "../src/log.ts";
import { router } from "../src/channels/serve.ts";
import { text } from "../src/channels/respond.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";

describe("serving surface", () => {
  it("can suppress the data plane for AgentCore's publicly forwarded surface", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-surface-"));
    const ordinary = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {});
    expect(Object.keys(ordinary.unverified)).toContain("POST /invoke");

    // The ONE posture that opts out: AgentCore serves the Runtime's `/invocations` contract instead.
    const agentcore = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {
      serveInvoke: false,
    });
    expect(Object.keys(agentcore.unverified)).toEqual(["GET /health"]);
  });

  it("mounts POST /trigger only where there is something to trigger, and reserves that path too", async () => {
    // It rides the unverified table for the reason that table exists: the JSON gate, the cross-origin
    // policy, the reserved path and the startup report's account of what is open all follow from being
    // in it — none of which this route had to ask for.
    const dir = await mkdtemp(join(tmpdir(), "fa-trigger-surface-"));
    const none = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {});
    expect(Object.keys(none.unverified)).not.toContain("POST /trigger");

    const schedules = [{ name: "digest", cron: "0 * * * *", tz: "UTC", prompt: "go" }];
    const withTrigger = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, { schedules });
    expect(Object.keys(withTrigger.unverified)).toContain("POST /trigger");

    // It FOLLOWS `serveInvoke`: `http.invoke: false` means "the channels' signature checks are the only
    // way in", and a second anonymous turn-starter appearing behind that choice would reverse it.
    const invokeOff = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {
      schedules,
      serveInvoke: false,
    });
    expect(Object.keys(invokeOff.unverified)).toEqual(["GET /health"]);
    // …with one explicit exception, which is the combination this route exists for: no `/invoke`, but
    // an external clock driving the schedules.
    const clockOnly = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {
      schedules,
      serveInvoke: false,
      serveTrigger: true,
    });
    expect(Object.keys(clockOnly.unverified).sort()).toEqual(["GET /health", "POST /trigger"]);

    // Reserved like /invoke: a channel taking the path would answer for a route every runbook names.
    const taken = await mkdtemp(join(tmpdir(), "fa-trigger-taken-"));
    await mkdir(join(taken, "channels"));
    await writeFile(
      join(taken, "channels", "mine.mjs"),
      `export default () => ({ "POST /trigger": () => new Response("mine") });\n`,
    );
    await expect(routesFor(taken, {} as Agent, join(taken, ".state"), undefined, { schedules })).rejects.toThrow(
      /channel route\(s\) "POST \/trigger" take a path this serve answers on itself/,
    );
  });

  it("serves the data plane beside a channel, and RESERVES its path against one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-invoke-surface-"));
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "hook.mjs"),
      `export default () => ({ "POST /hook": () => new Response("x") });\n`,
    );
    const beside = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {});
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
    await expect(routesFor(taken, {} as Agent, join(taken, ".state"), undefined, {})).rejects.toThrow(
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
    await expect(routesFor(anyMethod, {} as Agent, join(anyMethod, ".state"), undefined, {})).rejects.toThrow(
      /channel route\(s\) "\/invoke" take a path this serve answers on itself \("POST \/invoke"\)/,
    );
    // …but ONLY where this serve actually answers there: AgentCore serves the Runtime's `/invocations`
    // contract instead, so the same channel is legal on that posture and the refusal would be a lie.
    const onAgentcore = await routesFor(taken, {} as Agent, join(taken, ".state"), undefined, {
      serveInvoke: false,
    });
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
    const surface = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, {});
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
    // The clock's name for this fire. Recent, because `POST /trigger` refuses an occurrence older than
    // one period of the schedule that declares it (schedule/trigger.ts).
    const occurrence = new Date().toISOString();
    const fire = (name: string): Promise<Response> | Response =>
      routes["POST /invocations"]!(
        new Request("http://x/invocations", {
          method: "POST",
          body: JSON.stringify({ auth: "ingress-s3cret", kind: "schedule-fire", name, occurrence }),
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
  it("the control plane is reachable in the surface dev/start hand to serve", async () => {
    // The gap this closes: mountSessionControl returns routes AND mounts, and a caller forwarding
    // only the routes gets a server where every /control/* request 404s, while the startup line
    // still announces the prefix — an address that answers nothing. Every other test builds the
    // router directly; this one assembles it the way `serve` does, from the CLI's own output.
    const control = { capabilities: () => ({ commands: [], models: [] }) } as never;
    const withControl = mountSessionControl({ "GET /health": () => text("ok\n", 200) }, control);
    const surface = { ...withControl }; // exactly what dev/start spread into ServingSurface
    const handle = router({ selfVerifying: surface.routes, mounts: surface.mounts });
    // 200 from the plane, 404 from its absence.
    expect((await handle(new Request("http://h/control/capabilities"))).status).toBe(200);
    expect((await handle(new Request("http://h/health"))).status).toBe(200);
  });

  /** A serve that mounts the data plane — what most postures look like. */
  const withInvoke = (controlPrefix: string | undefined) => ({
    ...(controlPrefix ? { controlPrefix } : {}),
    unverifiedRoutes: ["POST /invoke", "GET /health"],
  });

  it("--no-invoke withholds the data plane for ONE run, without touching the definition", async () => {
    // `http.invoke: false` is the persistent form and travels into a deployed image. The case this
    // flag exists for is `dev --tunnel`: the standard way to register a chat channel's webhook, which
    // publishes the port at a public quick-tunnel URL — and would publish an anonymous, fully-tooled
    // `POST /invoke` alongside it. Same relationship `--bind` has to `http.host`.
    const opened = { serveInvoke: undefined, agentDir: "/x" } as unknown as MountableAgent;
    expect(withRunOverrides(opened, {})).toBe(opened); // no flag, nothing changed
    expect(withRunOverrides(opened, { invoke: false }).serveInvoke).toBe(false);
    // Only `false` overrides: an absent flag must not turn into "serve it", which would beat a
    // definition that said `http.invoke: false`.
    const configuredOff = { ...opened, serveInvoke: false } as MountableAgent;
    expect(withRunOverrides(configuredOff, {}).serveInvoke).toBe(false);
    expect(withRunOverrides(configuredOff, { invoke: true }).serveInvoke).toBe(false);

    // It takes `POST /trigger` with it, over a definition that asked for it. Both routes start a turn
    // for an anonymous caller, and `dev --tunnel --no-invoke` leaving the other one on the tunnel URL
    // would be the flag failing at the job it exists for.
    const triggerOn = { ...opened, serveTrigger: true } as MountableAgent;
    expect(withRunOverrides(triggerOn, { invoke: false }).serveTrigger).toBe(false);
    expect(withRunOverrides(triggerOn, {}).serveTrigger).toBe(true); // no flag, the definition stands
  });

  it("the cross-origin grant is said at EVERY boot, loopback included", async () => {
    // It is the default now (`*`), so nobody opts into it — and a loopback bind, which used to make a
    // page's cross-origin call impossible, no longer does. `dev` is the one posture the decision costs,
    // and it is exactly the one the reach warnings below stay silent on.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      announceControl(withInvoke("/control"), { host: "127.0.0.1", tunnel: false });
      const said = warn.mock.calls.flat().join(" ");
      expect(warn).toHaveBeenCalledTimes(1); // the grant, and nothing about reach
      expect(said).toMatch(/any web page your browser visits can call this serve cross-origin/);
      expect(said).toContain("POST /invoke");
      expect(said).toContain("http.cors");

      // `POST /trigger` is on the same table and is named the same way: it runs a turn too, from a
      // prompt the definition wrote down rather than one the caller sent.
      warn.mockClear();
      announceControl(
        { unverifiedRoutes: ["POST /invoke", "POST /trigger", "GET /health"] },
        { host: "127.0.0.1", tunnel: false },
      );
      expect(warn.mock.calls.flat().join(" ")).toContain("POST /trigger (fire any schedule this agent has)");

      // …and NOT once `http.cors` has taken it back — then the operator named the origins themselves.
      warn.mockClear();
      announceControl({ ...withInvoke("/control"), corsOrigins: ["https://app.example.com"] }, { tunnel: false });
      expect(warn.mock.calls.flat().join(" ")).not.toMatch(/any web page/);
      // `["*"]` is the default said out loud, so it is still the default's grant.
      warn.mockClear();
      announceControl({ ...withInvoke("/control"), corsOrigins: ["*"] }, { host: "127.0.0.1", tunnel: false });
      expect(warn.mock.calls.flat().join(" ")).toMatch(/any web page/);

      // Nothing of ours answers here (the AgentCore adapter's surface): no grant to describe.
      warn.mockClear();
      announceControl({ unverifiedRoutes: [] }, { host: "127.0.0.1", tunnel: false });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("announceControl names the reach: LAN and tunnel are warnings, loopback is not", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    /** Only the reach lines; the unconditional cross-origin grant is the test above. */
    const reachLines = () => warn.mock.calls.flat().filter((line) => !String(line).includes("any web page"));
    try {
      announceControl(withInvoke("/control"), { host: "127.0.0.1", tunnel: false });
      expect(reachLines()).toEqual([]); // loopback is not reachable off this machine

      // A specific non-wildcard bind is reachable as itself, and the warning NAMES that bind —
      // counting alone would stay green if the address rendered as `undefined`.
      announceControl(withInvoke("/control"), { host: "192.168.1.5", tunnel: false });
      expect(reachLines().join(" ")).toContain("192.168.1.5 (off this machine)");
      announceControl(withInvoke("/control"), { tunnel: false });
      expect(reachLines().join(" ")).toContain("binds all interfaces");
      expect(reachLines()).toHaveLength(2);

      // The tunnel takes the port PUBLIC, and nothing authenticates it — the word has to be there.
      announceControl(withInvoke("/control"), { host: "127.0.0.1", tunnel: true });
      expect(reachLines().join(" ")).toMatch(/--tunnel publishes this port.*NO authentication/s);

      // WITHOUT the control plane the exposure is still real: `POST /invoke` runs a turn on the
      // agent's own tools, and it is on every serve. This used to say nothing at all.
      warn.mockClear();
      announceControl(withInvoke(undefined), { host: "127.0.0.1", tunnel: true }); // the tunnel alone
      announceControl(withInvoke(undefined), { tunnel: false }); // the wildcard bind alone
      const withoutPlane = reachLines().join(" ");
      expect(reachLines()).toHaveLength(2); // the tunnel, and the wildcard bind
      expect(withoutPlane).toContain("POST /invoke");
      expect(withoutPlane).not.toContain("/control/*");

      // …and it names only what THIS process serves, from `unverifiedRoutes`. The AgentCore posture
      // answers the Runtime's /invocations behind IAM and mounts no /invoke; `http.invoke: false`
      // withholds it; a channel serving that path answers for itself, behind its own signature
      // check. A warning about an endpoint that is not ours teaches the operator to skim past all.
      warn.mockClear();
      announceControl({ unverifiedRoutes: [] }, { tunnel: true });
      expect(warn).not.toHaveBeenCalled();
      // With the control plane still published, the warning stands — naming only that.
      announceControl({ controlPrefix: "/control", unverifiedRoutes: [] }, { tunnel: true });
      const controlOnly = reachLines().join(" ");
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
