import { describe, expect, it } from "vitest";
import type { Routes } from "../src/channel.ts";
import {
  assertRouteKey,
  parseRouteKey,
  routeKeysConflict,
  pathUnderPrefix,
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

  it("pathUnderPrefix is segment-wise", () => {
    expect(pathUnderPrefix("/control", "/control")).toBe(true);
    expect(pathUnderPrefix("/control/state", "/control")).toBe(true);
    expect(pathUnderPrefix("/control/a/b", "/control")).toBe(true);
    expect(pathUnderPrefix("/controlled", "/control")).toBe(false); // NOT a prefix match on characters
    expect(pathUnderPrefix("/other", "/control")).toBe(false);
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

  it("a route inside a mount is refused — the mount owns everything beneath it", async () => {
    const plane = { prefix: "/control", handler: () => new Response("plane") };
    expect(() => router({ "GET /control/mine": () => new Response("x") }, [plane])).toThrow(/inside the mount/);
    expect(() => router({ "GET /control": () => new Response("x") }, [plane])).toThrow(/inside the mount/);
    expect(() => router({ "GET /controlled": () => new Response("x") }, [plane])).not.toThrow();
    // And the mount actually serves its prefix, including paths it does not itself route.
    const handle = router({ "GET /telegram": () => new Response("tg") }, [plane]);
    expect(await (await handle(new Request("http://h/control/anything"))).text()).toBe("plane");
    expect(await (await handle(new Request("http://h/control"))).text()).toBe("plane");
    expect(await (await handle(new Request("http://h/telegram"))).text()).toBe("tg");
  });

  it("a mount prefix is held to the same path rule as a route key", () => {
    // A prefix IS a path. Unchecked, `/files/:id` would be resolved by the matcher its own way while
    // pathUnderPrefix compared it as a literal — the exact split this language exists to close.
    const mount = (prefix: string) => () => router({}, [{ prefix, handler: () => new Response("m") }]);
    expect(mount("control")).toThrow(/must start/);
    expect(mount("/control/")).toThrow(/no trailing slash/);
    expect(mount("/")).toThrow(/owning every path IS that handler/); // the root is not a mount
    expect(mount("/control")).not.toThrow();
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

  it("a mount answers HEAD under the same rule as a route", async () => {
    // The mount branch returns before the route dispatch, so it needs the rule applied to it too —
    // otherwise the one handler has two HEAD semantics depending on which side answered.
    const handle = router({}, [{ prefix: "/p", handler: () => new Response("mount-body") }]);
    const head = await handle(new Request("http://h/p/x", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(await (await handle(new Request("http://h/p/x"))).text()).toBe("mount-body");
  });

  it("two mounts may not claim the same ground", () => {
    const at = (prefix: string) => ({ prefix, handler: () => new Response(prefix) });
    expect(() => router({}, [at("/control"), at("/control/admin")])).toThrow(/overlaps/);
    expect(() => router({}, [at("/control"), at("/control")])).toThrow(/overlaps/);
    expect(() => router({}, [at("/control"), at("/controlled")])).not.toThrow();
    expect(() => router({}, [at("/a"), at("/b")])).not.toThrow();
  });

  it("HEAD carries no content whichever route answers it", async () => {
    // Not only the GET fallback: an explicit HEAD route and a method-less one are HEAD responses too.
    const explicit = router({ "HEAD /x": () => new Response("should not ship") });
    expect(await (await explicit(new Request("http://h/x", { method: "HEAD" }))).text()).toBe("");
    const anyMethod = router({ "/x": () => new Response("should not ship") });
    expect(await (await anyMethod(new Request("http://h/x", { method: "HEAD" }))).text()).toBe("");
    expect(await (await anyMethod(new Request("http://h/x"))).text()).toBe("should not ship"); // GET unaffected
  });

  it("HEAD is answered from GET, without the content — and an explicit HEAD wins", async () => {
    // RFC 9110. Dropped here rather than left to the HTTP layer, because this handler is public
    // surface: a caller invoking it directly must get the same answer the socket would carry.
    const fromGet = router({ "GET /x": () => new Response("body", { headers: { "x-mark": "1" } }) });
    const head = await fromGet(new Request("http://h/x", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("x-mark")).toBe("1"); // headers survive; only the content goes
    expect(await head.text()).toBe("");
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
