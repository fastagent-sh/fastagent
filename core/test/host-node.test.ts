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
    expect(((await handle(req("POST", "/webhook"))) as Response).status).toBe(202);
    expect(((await handle(req("GET", "/health"))) as Response).status).toBe(200);
    expect(((await handle(req("DELETE", "/any"))) as Response).status).toBe(200); // method-agnostic key
    expect(((await handle(req("GET", "/webhook"))) as Response).status).toBe(405); // path exists, wrong method
    expect(((await handle(req("GET", "/missing"))) as Response).status).toBe(404);
  });
});

describe("host/node: serveNode", () => {
  it("serves a route, keeps `background` alive, and drains it on shutdown", async () => {
    let ran = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handler = () => ({
      response: new Response(null, { status: 202 }),
      background: gate.then(() => {
        ran = true;
      }),
    });

    const host = serveNode(handler, { port: 0 });
    const port = await host.listening;
    const res = await fetch(`http://127.0.0.1:${port}/x`, { method: "POST" });
    expect(res.status).toBe(202); // ACK returns before the background settles
    expect(ran).toBe(false);

    release(); // let the background work finish
    await host.drain(); // drain awaits the in-flight background
    expect(ran).toBe(true);
    await host.close();
  });
});
