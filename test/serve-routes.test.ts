import { describe, expect, it } from "vitest";
import type { Routes } from "../src/channel.ts";
import {
  assertRouteKey,
  parseRouteKey,
  routeKeysOverlap,
  routePathsOverlap,
  router,
  serveNode,
} from "../src/channels/serve.ts";

describe("serve: router", () => {
  const routes: Routes = {
    "POST /webhook": () => new Response("hook", { status: 202 }),
    "GET /health": () => new Response("ok"),
    "/any": () => new Response("any-method"),
  };
  const handle = router(routes);
  const req = (method: string, path: string) => new Request(`http://h${path}`, { method });

  it("HEAD is served by a GET route, with no body", async () => {
    // Deliberate, and a change from the hand-rolled matcher that answered 405: RFC 9110 makes HEAD
    // identical to GET except for the content, so a server supporting GET on a path supports HEAD
    // on it. The control plane advertises only GET in allow-methods, which is what a browser obeys.
    const handle = router({ "GET /x": () => new Response("body-here") });
    const head = await handle(new Request("http://h/x", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("a PATTERN route reports a method miss as 405, like a literal one", async () => {
    // The 404/405 split must be decided by the matcher that dispatches. Comparing pathname strings
    // works only for literal keys: `/files/a.txt` is matched by `POST /files/*` yet equals no key,
    // so a GET to it would answer 404 — and a remote client reads 404 as "this serve predates the
    // route", i.e. version skew, rather than as the wrong method.
    const handle = router({ "POST /files/*": () => new Response("stored", { status: 201 }) });
    const req = (method: string, path: string) => new Request(`http://h${path}`, { method });
    expect((await handle(req("POST", "/files/a.txt"))).status).toBe(201);
    expect((await handle(req("GET", "/files/a.txt"))).status).toBe(405); // matched the path, not the method
    expect((await handle(req("GET", "/elsewhere"))).status).toBe(404);
  });

  it("matches method + path, 405 on a known path with the wrong method, 404 otherwise", async () => {
    expect((await handle(req("POST", "/webhook"))).status).toBe(202);
    expect((await handle(req("GET", "/health"))).status).toBe(200);
    expect((await handle(req("DELETE", "/any"))).status).toBe(200); // method-agnostic key
    expect((await handle(req("GET", "/webhook"))).status).toBe(405); // path exists, wrong method
    expect((await handle(req("GET", "/missing"))).status).toBe(404);
  });
});

describe("serve: the route path language", () => {
  it("a prefix mount overlaps everything beneath it; literals only overlap when equal", () => {
    // The question every collision check asks. It has to be decidable, which is why the language is
    // literal paths + `/*` mounts and nothing else: a prefix mount answers for paths it does not
    // serve (its own 404), so an unnoticed overlap is a channel silently going dark.
    expect(routePathsOverlap("/control/*", "/control/state")).toBe(true);
    expect(routePathsOverlap("/control/state", "/control/*")).toBe(true);
    expect(routePathsOverlap("/control/*", "/control")).toBe(true);
    expect(routePathsOverlap("/control/*", "/control/anything/deep")).toBe(true);
    expect(routePathsOverlap("/control/*", "/controlled")).toBe(false); // prefix is path-segment-wise
    expect(routePathsOverlap("/a", "/a")).toBe(true);
    expect(routePathsOverlap("/a", "/b")).toBe(false);
    expect(routePathsOverlap("/a/*", "/b/*")).toBe(false);
    expect(routePathsOverlap("/a/*", "/a/b/*")).toBe(true);
  });

  it("an empty method means any method, to every reader of the key", async () => {
    // `" /x"` yields an empty method. As `""` it was falsy to the router (any method) but a real
    // method to the collision check, so `" /x"` and `"GET /x"` passed as distinct and then fought
    // over the same requests. Both questions must get the same answer.
    expect(parseRouteKey(" /x")).toEqual({ path: "/x" });
    expect(parseRouteKey("/x")).toEqual({ path: "/x" });
    expect(parseRouteKey("GET /x")).toEqual({ method: "GET", path: "/x" });
    const handle = router({ " /any": () => new Response("any-method") });
    expect((await handle(new Request("http://h/any", { method: "DELETE" }))).status).toBe(200);
  });

  it("router() refuses a table whose own routes fight each other", () => {
    // Registration order would decide the winner and nothing would say so. `loadChannels` reports
    // this across FILES; within one table — the shape an embedder hands over directly — it is a
    // plain configuration error, and refusing it is what makes "a prefix mount owns everything
    // beneath it" true for every caller rather than only for channel directories.
    expect(() => router({ "/files/*": () => new Response("a"), "GET /files/report": () => new Response("b") })).toThrow(
      /overlaps .* would never receive a request/,
    );
    expect(() => router({ "/x": () => new Response("a"), "GET /x": () => new Response("b") })).toThrow(/overlaps/);
    // Distinct methods on one path are the normal case and must stay legal.
    expect(() => router({ "GET /x": () => new Response("a"), "POST /x": () => new Response("b") })).not.toThrow();
    expect(() => router({ "/a/*": () => new Response("a"), "/b/*": () => new Response("b") })).not.toThrow();
  });

  it("routeKeysOverlap asks the WHOLE question: paths overlap AND methods are compatible", () => {
    expect(routeKeysOverlap("GET /x", "POST /x")).toBe(false); // same path, different methods
    expect(routeKeysOverlap("GET /x", "GET /x")).toBe(true);
    expect(routeKeysOverlap("/x", "GET /x")).toBe(true); // no method answers every method
    expect(routeKeysOverlap("/control/*", "GET /control/state")).toBe(true);
    expect(routeKeysOverlap("POST /a", "POST /b")).toBe(false);
  });

  it("a HEAD route is refused outright — the matcher can never reach one", async () => {
    // Verified against the matcher, not assumed: a HEAD request takes the GET route in EITHER
    // registration order, and a HEAD-ONLY route 404s. So this is never a second method on a path,
    // it is a handler that cannot run. Refusing it beats shipping dead code that looks mounted.
    expect(() => router({ "HEAD /x": () => new Response("") })).toThrow(/never runs/);
    expect(() => router({ "GET /x": () => new Response("g"), "HEAD /x": () => new Response("") })).toThrow(
      /never runs/,
    );
    // GET keeps answering HEAD, which is what makes the refusal safe rather than a lost capability.
    const handle = router({ "GET /x": () => new Response("body") });
    expect((await handle(new Request("http://h/x", { method: "HEAD" }))).status).toBe(200);
  });

  it("router() enforces the language too, not just the channel loader", () => {
    // Two doors lead to the matcher: channel files, and an embedder handing over `Routes`. A pattern
    // slipping through the second one would match at runtime while every collision check — which
    // reads paths as literals — quietly answers the wrong question about it.
    expect(() => router({ "GET /users/:id": () => new Response("x") })).toThrow(/parameter patterns/);
    expect(() => router({ "GET /files/*/raw": () => new Response("x") })).toThrow(/trailing/);
    expect(() => router({ "GET /files/*": () => new Response("x") })).not.toThrow();
  });

  it("rejects the patterns that would make overlap undecidable", () => {
    const check = (key: string) => () => assertRouteKey(key, (problem) => `bad: ${problem}`);
    expect(check("/files/:id")).toThrow(/parameter patterns/);
    expect(check("/files/*/raw")).toThrow(/trailing/);
    expect(check("files")).toThrow(/must start/);
    expect(check("/files/*")).not.toThrow();
    expect(check("/files")).not.toThrow();
  });
});

describe("serve: serveNode", () => {
  it("serving does not swap the process's global Request/Response", async () => {
    // fastagent is EMBEDDED: the host may not reshape the globals of the app it is mounted in. The
    // failure is not hypothetical either — a channel holding a Response captured before mount would
    // fail an `instanceof` against a swapped constructor and be answered 500.
    const NativeResponse = globalThis.Response;
    const NativeRequest = globalThis.Request;
    const host = serveNode(async () => new NativeResponse("held-from-before-mount"), { port: 0 });
    const port = await host.listening;
    try {
      expect(globalThis.Response).toBe(NativeResponse);
      expect(globalThis.Request).toBe(NativeRequest);
      const res = await fetch(`http://127.0.0.1:${port}/x`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("held-from-before-mount");
    } finally {
      await host.close();
    }
  });

  it("a bind failure rejects `listening` instead of hanging", async () => {
    const first = serveNode(() => new Response("ok"), { port: 0, host: "127.0.0.1" });
    const taken = await first.listening;
    try {
      const second = serveNode(() => new Response("ok"), { port: taken, host: "127.0.0.1" });
      await expect(second.listening).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.close();
    }
  });

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
