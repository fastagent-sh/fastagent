import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Routes } from "../../../src/channel.ts";
import type { AnyChannelModule } from "../../../src/channels/discover.ts";
import { router } from "../../../src/channels/router.ts";
import { routesFor } from "../../../src/service.ts";
import { scriptedAgent } from "../../doubles/scripted-agent.ts";
import { scriptedRun } from "../../doubles/scripted-run.ts";

describe("serve: router", () => {
  const routes: Routes = {
    "POST /webhook": () => new Response("hook", { status: 202 }),
    "GET /health": () => new Response("ok"),
    "/any": () => new Response("any-method"),
  };
  const handle = router(routes);
  const req = (method: string, path: string) => new Request(`http://h${path}`, { method });

  it("matches method + path, 405 on a known path with the wrong method, 404 otherwise", async () => {
    expect((await handle(req("POST", "/webhook"))).status).toBe(202);
    expect((await handle(req("GET", "/health"))).status).toBe(200);
    expect((await handle(req("DELETE", "/any"))).status).toBe(200); // method-agnostic key
    expect((await handle(req("GET", "/webhook"))).status).toBe(405); // path exists, wrong method
    expect((await handle(req("GET", "/missing"))).status).toBe(404);
  });
});

describe("serving surface: routesFor", () => {
  const agent = scriptedAgent((request) => scriptedRun(request));
  const channels = (modules: Record<string, unknown>) =>
    new Map(Object.entries(modules) as [string, AnyChannelModule][]);

  it("serves the channels' routes, with health beside them unless a channel serves it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-surface-"));
    const beside = routesFor(agent, dir, channels({ hook: () => ({ "POST /hook": () => new Response("x") }) }));
    expect(Object.keys(beside.routes).sort()).toEqual(["GET /health", "POST /hook"]);
    const own = routesFor(agent, dir, channels({ probe: () => ({ "/health": () => new Response("mine") }) }));
    expect(await (await own.routes["/health"]!(new Request("http://x/health"))).text()).toBe("mine");
    expect(Object.keys(own.routes)).toEqual(["/health"]);
  });
});
