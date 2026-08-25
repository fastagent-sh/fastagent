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
  it("a route key is a literal path — every pattern is refused", () => {
    const check = (key: string) => () => assertRouteKey(key, (problem) => `bad: ${problem}`);
    // The language is small so that "would these two fight over a request?" is a COMPARISON rather
    // than a prediction about the matcher. Every pattern admitted here would have to be predicted
    // instead — by this check and by every other one — which is a model that drifts from what it
    // models. That drift is what this narrowing removes.
    expect(check("/files/*")).toThrow(/literal path/);
    expect(check("/files/:id")).toThrow(/literal path/);
    expect(check("/%63ontrol/mine")).toThrow(/percent-encoding/);
    expect(check("GET /x?y=1")).toThrow(/not part of a path/);
    expect(check("/x#frag")).toThrow(/not part of a path/);
    expect(check("files")).toThrow(/must start/);
    // Spellings a URL normalises away: the request arrives as something else, so the route never
    // runs — and the two spellings compare as different strings, slipping past every conflict check.
    expect(check("/a/../x")).toThrow(/segments are not allowed/);
    expect(check("/a/./y")).toThrow(/segments are not allowed/);
    expect(check("GET /a\\b")).toThrow(/path separator/);
    expect(check("/a..b")).not.toThrow(); // dots inside a segment are ordinary characters
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
    expect(mount("/files/:id")).toThrow(/literal path/);
    expect(mount("/files/*")).toThrow(/literal path/);
    expect(mount("/%63ontrol")).toThrow(/percent-encoding/);
    expect(mount("control")).toThrow(/must start/);
    expect(mount("/control/")).toThrow(/no trailing slash/);
    expect(mount("/control")).not.toThrow();
  });

  it("two mounts may not claim the same ground", () => {
    const at = (prefix: string) => ({ prefix, handler: () => new Response(prefix) });
    expect(() => router({}, [at("/control"), at("/control/admin")])).toThrow(/overlaps/);
    expect(() => router({}, [at("/control"), at("/control")])).toThrow(/overlaps/);
    expect(() => router({}, [at("/control"), at("/controlled")])).not.toThrow();
    expect(() => router({}, [at("/a"), at("/b")])).not.toThrow();
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
    expect(() => router({ "GET /users/:id": () => new Response("x") })).toThrow(/literal path/);
    expect(() => router({ "GET /files/*": () => new Response("x") })).toThrow(/literal path/);
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
