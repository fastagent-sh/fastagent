import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent.ts";
import { mountAgentcore, routesFor } from "../src/cli/serve.ts";
import { text } from "../src/channels/respond.ts";
import type { LoadedSchedule } from "../src/schedule/schedule.ts";

describe("serving surface", () => {
  it("can suppress the fallback /invoke for AgentCore's publicly forwarded surface", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-surface-"));
    const ordinary = await routesFor(dir, {} as Agent, join(dir, ".state"));
    expect(Object.keys(ordinary.routes)).toContain("POST /invoke");
    expect(ordinary.builtinInvoke).toBe(true);

    const agentcore = await routesFor(dir, {} as Agent, join(dir, ".state"), undefined, { builtinInvoke: false });
    expect(Object.keys(agentcore.routes)).toEqual(["GET /health"]);
    expect(agentcore.builtinInvoke).toBe(false);
  });

  it("keeps health but does not add the fallback /invoke for a long-connection channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-long-connection-surface-"));
    await mkdir(join(dir, "channels"));
    await writeFile(
      join(dir, "channels", "socket.mjs"),
      `export default { name: "socket", connect: () => ({ ready: Promise.resolve(), closed: new Promise(() => {}) }) };\n`,
    );
    const surface = await routesFor(dir, {} as Agent, join(dir, ".state"));
    expect(Object.keys(surface.routes)).toEqual(["GET /health"]);
    expect(surface.builtinInvoke).toBe(false);
    expect(surface.longConnections.map((connection) => connection.name)).toEqual(["socket"]);
    expect(surface.routeChannels).toEqual([]);
    const health = surface.routes["GET /health"]!;
    expect((await health(new Request("http://x/health"))).status).toBe(503);
    surface.markReady();
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

  it("mounts /invocations + /ping over the serving routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-mount-"));
    const routes = mountAgentcore(
      { "POST /telegram": () => text("ok\n", 200) },
      { agent, stateRoot: dir, schedules: [] },
    );
    expect(Object.keys(routes).sort()).toEqual(["GET /ping", "POST /invocations", "POST /telegram"]);
    expect(await (await routes["GET /ping"]!(new Request("http://x/ping"))).json()).toEqual({ status: "Healthy" });
  });

  it("fails startup on a channel colliding with the adapter's paths", () => {
    expect(() =>
      mountAgentcore({ "POST /invocations": () => text("mine\n", 200) }, { agent, stateRoot: "/tmp", schedules: [] }),
    ).toThrow(/collide with the AgentCore adapter/);
  });

  it("binds schedule fires by name — an unknown name 404s through the adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-fire-"));
    // schedule-fire is an INTERNAL kind: without the ingress secret the adapter 403s it before
    // routing (see the adapter's authentication boundary), so the mount must carry it.
    process.env.FASTAGENT_INGRESS_SECRET = "ingress-s3cret";
    const routes = mountAgentcore({}, { agent, stateRoot: dir, schedules: [schedule] });
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
    const { readyAddressLines } = await import("../src/cli/serve.ts");
    const { bindAddress } = await import("../src/bind.ts");
    // `localhost` is IN the list on purpose: it is the only accepted input that could put a NAME in
    // these lines, so leaving it out would make the `not.toContain("localhost")` below pass for the
    // reason that it was never tried. It cannot get here — `parseBind`/`http.host` resolve it to an
    // address first (bind.ts `bindAddress`) — and this is what says so.
    for (const host of [undefined, "0.0.0.0", "127.0.0.1", "192.168.1.5", "::1", bindAddress("localhost")]) {
      const [bindLine, tryLine] = readyAddressLines(host, 8899, true);
      const dial = tryLine!.match(/curl -s (\S+?)\/invoke/)![1]!;
      expect(dial, String(host)).toContain(":8899");
      expect(dial, String(host)).not.toContain("localhost"); // never a name the bind may not answer
      // A wildcard bind IS every interface, so the report says so rather than understating it as one
      // address — but the curl still has to dial something, and loopback is what a wildcard answers.
      expect(bindLine, String(host)).toContain(
        host === undefined || host === "0.0.0.0" ? ":8899 (all interfaces)" : dial,
      );
      if (host === "::1") expect(dial).toBe("[::1]:8899"); // URL form, brackets and all
    }
    // No builtin invoke route, no curl to offer — and still exactly one line about the bind.
    expect(readyAddressLines("127.0.0.1", 1, false)).toHaveLength(1);
  });
});
