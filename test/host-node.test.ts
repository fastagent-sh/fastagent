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

  it("binds only the given host, leaving every other address unserved", async () => {
    const host = serveNode(() => new Response("ok"), { port: 0, host: "127.0.0.1" });
    const port = await host.listening;
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    // The negative goes to a second LOOPBACK alias, not to a LAN address: `127.0.0.2` is the whole
    // point of the bind (loopback by reach, still not the address bound), it needs no network, and it
    // cannot pass for the wrong reason — a LAN probe picks up whatever interface is first, often a
    // VPN/docker one where the refusal comes from routing, and a FILTERED interface would hang the
    // fetch with no timeout until vitest killed the file.
    await expect(fetch(`http://127.0.0.2:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    await host.close();
  });

  it("can force-close an active request instead of waiting for the handler to drain", async () => {
    let entered!: () => void;
    const handling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const host = serveNode(
      async () => {
        entered();
        await new Promise<never>(() => {});
        return new Response();
      },
      { port: 0 },
    );
    const port = await host.listening;
    const request = fetch(`http://127.0.0.1:${port}/stream`).catch((error: unknown) => error);
    await handling;

    const closing = host.close();
    host.closeAllConnections();
    await expect(closing).resolves.toBeUndefined();
    await expect(request).resolves.toBeInstanceOf(Error);
  });
});
