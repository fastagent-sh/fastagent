import { describe, expect, it } from "vitest";
import { type Routes, router, serveNode } from "../src/host/node.ts";

describe("host/node: router", () => {
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

describe("host/node: serveNode", () => {
  it("binds a handler, serves it over HTTP, and closes the socket", async () => {
    const host = serveNode((req) => new Response(`hi ${new URL(req.url).pathname}`), { port: 0 });
    const port = await host.listening;
    const res = await fetch(`http://127.0.0.1:${port}/x`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi /x");
    await host.close(); // caller-owned shutdown — releases the listening socket
  });
});
