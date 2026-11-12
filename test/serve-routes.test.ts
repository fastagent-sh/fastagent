import { describe, expect, it } from "vitest";
import type { Routes } from "../src/channel.ts";
import { router } from "../src/channels/router.ts";

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
