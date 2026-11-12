import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AnyChannelModule } from "../src/channels/discover.ts";
import { routesFor } from "../src/service.ts";
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
});
