import { describe, expect, it, vi } from "vitest";
import { type Routes, assertRoutes, router, serveNode } from "../src/host/node.ts";

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

describe("host/node: assertRoutes", () => {
  it("accepts a synchronous Routes object of handlers", () => {
    const routes = { "POST /x": () => new Response(null) };
    expect(assertRoutes(routes)).toBe(routes);
  });

  it("fails visibly when the factory is async (returns a Promise)", () => {
    // what `channels: async (agent) => ({...})` produces
    expect(() => assertRoutes(Promise.resolve({ "POST /x": () => new Response(null) }))).toThrow(/synchronous/);
  });

  it("rejects non-objects and non-function route values", () => {
    expect(() => assertRoutes(null)).toThrow(/Routes object/);
    expect(() => assertRoutes("nope")).toThrow(/Routes object/);
    expect(() => assertRoutes({ "POST /x": 1 })).toThrow(/handler function/);
  });

  it("rejects an empty route table (the same silent-empty-server it guards against)", () => {
    expect(() => assertRoutes({})).toThrow(/no routes/);
  });

  it("rejects route keys that wouldn't match a pathname (no slash / whitespace / query / fragment)", () => {
    const h = () => new Response(null);
    expect(() => assertRoutes({ "POST webhook": h })).toThrow(/pathname/); // missing leading slash
    expect(() => assertRoutes({ "POST  /webhook": h })).toThrow(/pathname/); // double space → path " /webhook"
    expect(() => assertRoutes({ "POST /webhook ": h })).toThrow(/pathname/); // trailing space
    expect(() => assertRoutes({ "GET /health?x=1": h })).toThrow(/pathname/); // query string
    expect(() => assertRoutes({ "POST //webhook": h })).toThrow(/pathname/); // // → URL reads it as a host; a blocklist would miss this, round-trip catches it
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

  it("turns a handler exception into a 500, logs it, and does not leak the message to the client", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const host = serveNode(
      () => {
        throw new Error("boom-secret-detail");
      },
      { port: 0 },
    );
    const port = await host.listening;
    const res = await fetch(`http://127.0.0.1:${port}/x`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("boom-secret-detail"); // generic body, no leak to the client
    expect(errors.some((e) => e.includes("boom-secret-detail"))).toBe(true); // but logged operator-side
    spy.mockRestore();
    await host.close();
  });

  it("a rejecting background is observed (no unhandled rejection) and still drains", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const host = serveNode(
      () => ({ response: new Response(null, { status: 202 }), background: Promise.reject(new Error("boom")) }),
      { port: 0 },
    );
    const port = await host.listening;
    const res = await fetch(`http://127.0.0.1:${port}/x`, { method: "POST" });
    expect(res.status).toBe(202);
    await host.drain(); // must not throw despite the rejection
    expect(errors.some((e) => e.includes("boom"))).toBe(true); // surfaced, not swallowed
    spy.mockRestore();
    await host.close();
  });
});
