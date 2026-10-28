import { describe, expect, it } from "vitest";
import type { Routes } from "../src/channel.ts";
import { assertRouteKey, parseRouteKey, routeKeysConflict, router } from "../src/channels/router.ts";
import { serveHandler } from "../src/channels/serve.ts";

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

describe("serve: the route path language", () => {
  it("refuses only what would cost another channel", () => {
    const check = (key: string) => () => assertRouteKey(key, (problem) => `bad: ${problem}`);
    // A pattern character is a literal here, so such a key just never matches — its author's
    // problem, not another channel's. Not policed.
    expect(check("/files/*")).not.toThrow();
    expect(check("/files/:id")).not.toThrow();
    // Anything `URL` rewrites: the request arrives under the rewritten path, so the key is both
    // unreachable AND invisible to the conflict check (`/a/../x` and `/x` are one route).
    expect(check("GET /x?y=1")).toThrow(/arrives as "\/x"/);
    expect(check("/x#frag")).toThrow(/arrives as "\/x"/);
    expect(check("/a/../x")).toThrow(/arrives as "\/x"/);
    expect(check("/a/./y")).toThrow(/arrives as "\/a\/y"/);
    expect(check("/%2e%2e/x")).toThrow(/arrives as "\/x"/);
    expect(check("GET /a\\b")).toThrow(/arrives as/);
    expect(check("files")).toThrow(/must start/);
    expect(check(" /x")).toThrow(/leading space is not a method/);
    expect(check("/files")).not.toThrow();
    expect(check("POST /a/b/c")).not.toThrow();
  });

  it("a leading space is refused, not quietly read as 'any method'", async () => {
    // Normalising `" /x"` would define a spelling the contract does not have — and define it only
    // in the parser's head. The author meant `"/x"`, which is the documented way to say any method.
    expect(() => router({ " /x": () => new Response("x") })).toThrow(/leading space is not a method/);
    expect(parseRouteKey("/x")).toEqual({ path: "/x" });
    expect(parseRouteKey("GET /x")).toEqual({ method: "GET", path: "/x" });
    const handle = router({ "/any": () => new Response("any-method") });
    expect((await handle(new Request("http://h/any", { method: "DELETE" }))).status).toBe(200);
  });

  it("an unusual method is a route like any other — the client's limits are not ours", async () => {
    // `fetch` refuses to CONSTRUCT a TRACE request, which is a client-side rule. A server still
    // receives one over a raw socket, so refusing the route here would remove a working capability
    // to describe someone else's limitation.
    const check = (key: string) => () => assertRouteKey(key, (problem) => `bad: ${problem}`);
    expect(check("PROPFIND /x")).not.toThrow(); // extension methods are ordinary
    const handle = router({ "TRACE /x": () => new Response("traced") });
    expect(await (await handle(new Request("http://h/x", { method: "GET" }))).status).toBe(405);
    const raw = new Request("http://h/x");
    Object.defineProperty(raw, "method", { value: "TRACE" });
    expect(await (await handle(raw)).text()).toBe("traced");
  });

  it("a lower-case method is the same route, and reaches its handler", async () => {
    // The method is upper-cased when the key is parsed, so validation and conflict-checking already
    // agree that `"get /x"` is `GET /x`. Dispatch has to agree too, or the route starts and never runs.
    const handle = router({ "get /x": () => new Response("hit") });
    expect(await (await handle(new Request("http://h/x"))).text()).toBe("hit");
    expect(() => router({ "get /x": () => new Response("a"), "GET /x": () => new Response("b") })).toThrow(/conflicts/);
  });

  it("router() refuses two keys that name the same route", () => {
    // The object's own key uniqueness does not catch this: `"/x"` and `"GET /x"` are different keys
    // for the same request, and registration order would silently pick a winner.
    expect(() => router({ "/x": () => new Response("a"), "GET /x": () => new Response("b") })).toThrow(/conflicts/);
    // Distinct methods on one path are the normal case and must stay legal.
    expect(() => router({ "GET /x": () => new Response("a"), "POST /x": () => new Response("b") })).not.toThrow();
  });

  it("routeKeysConflict compares, it does not predict", () => {
    expect(routeKeysConflict("GET /x", "POST /x")).toBe(false); // same path, different methods
    expect(routeKeysConflict("GET /x", "GET /x")).toBe(true);
    expect(routeKeysConflict("/x", "GET /x")).toBe(true); // no method answers every method
    expect(routeKeysConflict("POST /a", "POST /b")).toBe(false);
  });

  it("even the router's own 404 and 405 carry no content for HEAD", async () => {
    // These are written by the router, not by a handler — the earlier version stripped only handler
    // replies, so the one function had two HEAD semantics depending on who answered.
    const handle = router({ "POST /x": () => new Response("x") });
    const missing = await handle(new Request("http://h/nope", { method: "HEAD" }));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
    const wrongMethod = await handle(new Request("http://h/x", { method: "HEAD" }));
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.text()).toBe("");
  });

  it("HEAD is answered from GET without the content, whichever route answers — and an explicit HEAD wins", async () => {
    // RFC 9110. Dropped here rather than left to the HTTP layer, because this handler is public
    // surface: a caller invoking it directly must get the same answer the socket would carry.
    const fromGet = router({ "GET /x": () => new Response("body", { headers: { "x-mark": "1" } }) });
    const head = await fromGet(new Request("http://h/x", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("x-mark")).toBe("1"); // headers survive; only the content goes
    expect(await head.text()).toBe("");
    // Not only the GET fallback: an explicit HEAD route and a method-less one are HEAD responses too.
    const explicitOnly = router({ "HEAD /x": () => new Response("should not ship") });
    expect(await (await explicitOnly(new Request("http://h/x", { method: "HEAD" }))).text()).toBe("");
    const anyMethod = router({ "/x": () => new Response("should not ship") });
    expect(await (await anyMethod(new Request("http://h/x", { method: "HEAD" }))).text()).toBe("");
    expect(await (await anyMethod(new Request("http://h/x"))).text()).toBe("should not ship"); // GET unaffected
    // Writing one explicitly is allowed, and takes precedence — nothing here is unreachable.
    const explicit = router({
      "GET /x": () => new Response("get"),
      "HEAD /x": () => new Response("", { headers: { "x-who": "head" } }),
    });
    expect((await explicit(new Request("http://h/x", { method: "HEAD" }))).headers.get("x-who")).toBe("head");
  });

  it("router() enforces the language too, not just the channel loader", () => {
    // Two doors lead to the matcher: channel files, and an embedder handing over `Routes`. A pattern
    // slipping through the second one would match at runtime while every collision check — which
    // reads paths as literals — quietly answers the wrong question about it.
    expect(() => router({ "GET /x?y=1": () => new Response("x") })).toThrow(/arrives as/);
    expect(() => router({ " /x": () => new Response("x") })).toThrow(/leading space/);
  });
});

describe("serve: serveHandler", () => {
  it("serving does not swap the process's global Request/Response", async () => {
    // fastagent is EMBEDDED: the host may not reshape the globals of the app it is mounted in. The
    // failure is not hypothetical either — a channel holding a Response captured before mount would
    // fail an `instanceof` against a swapped constructor and be answered 500.
    const NativeResponse = globalThis.Response;
    const NativeRequest = globalThis.Request;
    const host = serveHandler(async () => new NativeResponse("held-from-before-mount"), { port: 0 });
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
    const first = serveHandler(() => new Response("ok"), { port: 0, host: "127.0.0.1" });
    const taken = await first.listening;
    try {
      const second = serveHandler(() => new Response("ok"), { port: taken, host: "127.0.0.1" });
      await expect(second.listening).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.close();
    }
  });

  it("binds a handler, serves it over HTTP, and closes the socket", async () => {
    const host = serveHandler((req) => new Response(`hi ${new URL(req.url).pathname}`), { port: 0 });
    const port = await host.listening;
    const res = await fetch(`http://127.0.0.1:${port}/x`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi /x");
    await host.close(); // caller-owned shutdown — releases the listening socket
  });

  it("binds only the given host, leaving every other address unserved", async () => {
    const host = serveHandler(() => new Response("ok"), { port: 0, host: "127.0.0.1" });
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

  it("closing before it listened binds nothing, and says so through `listening`", async () => {
    const host = serveHandler(() => new Response("ok"), { port: 0 });
    await host.close();
    await expect(host.listening).rejects.toThrow(/closed before it listened/);
  });

  it("closing gives a request in flight a moment, and ends one that takes longer", async () => {
    let entered!: () => void;
    const handling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const host = serveHandler(
      async (req) => {
        if (new URL(req.url).pathname === "/quick") {
          entered();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return new Response("done");
        }
        await new Promise<never>(() => {});
        return new Response();
      },
      { port: 0 },
    );
    const port = await host.listening;
    const answer = (path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`).then(
        async (res) => `${res.status} ${await res.text()}`,
        (error: unknown) => error,
      );
    const never = answer("/never");
    const quick = answer("/quick");
    await handling;
    const started = Date.now();
    await host.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await quick).toBe("200 done");
    expect(await never).toMatch(/^503/);
  });
});
