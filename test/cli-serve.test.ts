import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
