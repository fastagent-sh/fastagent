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

describe("serve: who may call this from a browser", () => {
  // THE cross-origin policy, tested where it lives (channels/serve.ts). Every route this process
  // serves is unauthenticated by design, so the allowance IS the access control: a wildcard would
  // hand any page the developer has open a working client for `POST /invoke` and `/control/*`.
  /** What ran. The side effect is the finding: a refused page must not reach a handler at all. */
  let ran: string[] = [];
  const plane = {
    prefix: "/control",
    handler: () => {
      ran.push("plane");
      return new Response("plane");
    },
  };
  const ours: Routes = {
    "POST /invoke": () => {
      ran.push("invoke");
      return new Response("ours");
    },
  };
  const channels: Routes = {
    "POST /telegram": () => {
      ran.push("telegram");
      return new Response("a platform's");
    },
  };
  const build = (corsOrigins?: string[]) => {
    ran = [];
    return router(ours, channels, [plane], { ...(corsOrigins ? { corsOrigins } : {}) });
  };
  const preflight = (handle: ReturnType<typeof router>, path: string, origin: string, method = "POST") =>
    handle(
      new Request(`http://h${path}`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": method },
      }),
    );

  it("answers the preflight for a route registered under POST only — the router is the only layer that can", async () => {
    // `routesFor` registers `"POST /invoke"`, so `OPTIONS /invoke` matches no key: left to the route
    // table it is a 405 with no CORS headers, and a browser sending `content-type: application/json`
    // never gets to make the real request. A handler's own OPTIONS branch cannot fix that — it is
    // never reached.
    const res = await preflight(build(), "/invoke", "http://127.0.0.1:5173");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("echoes the headers the preflight asked for — a fixed list is a 204 the browser refuses to act on", async () => {
    // `connectSessionControl({ fetchFn })` exists so a caller can satisfy whatever fronts this port.
    // A fixed allow-list cannot know that header's name, so the preflight would pass and the real
    // request would never be sent.
    const res = await build()(
      new Request("http://h/invoke", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-gateway-key, content-type",
        },
      }),
    );
    expect(res.headers.get("access-control-allow-headers")).toBe("x-gateway-key, content-type");
    // A preflight that asked about no header still gets what a client of ours always needs.
    const bare = await preflight(build(), "/invoke", "http://localhost:5173");
    expect(bare.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
  });

  it("a published port is an ordinary API: the cross-origin default is `*`", async () => {
    // Origin is not access control. What makes a normal API safe to call from any page is a credential
    // the page does not have; on a PUBLISHED port the same conclusion holds for the opposite reason —
    // anyone can already curl it, so answering a browser hands an attacker nothing new. What is in
    // front of a published port is the deployment's decision, and guessing conservatively there is us
    // doing the operator's job badly.
    const handle = router(ours, channels, [plane], { published: true });
    const res = await preflight(handle, "/invoke", "https://app.example.com");
    expect({ status: res.status, allowed: res.headers.get("access-control-allow-origin") }).toEqual({
      status: 204,
      allowed: "*",
    });
    // …and `http.cors` still NARROWS it, which is the other half of that knob.
    const pinned = router(ours, channels, [plane], {
      published: true,
      corsOrigins: ["https://app.example.com"],
    });
    expect(
      (await preflight(pinned, "/invoke", "https://app.example.com")).headers.get("access-control-allow-origin"),
    ).toBe("https://app.example.com");
    expect(
      (await preflight(pinned, "/invoke", "https://other.example.com")).headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  it("the JSON gate covers the whole unverified surface, and exempts the channels", async () => {
    // Applied by the ROUTER, not by each handler: the next unverified route we add is covered by
    // existing. A channel is exempt because it verifies its platform's signature inside itself —
    // Slack posts `application/x-www-form-urlencoded`, and a page cannot forge that signature.
    const handle = build();
    const post = (path: string, contentType?: string) =>
      handle(
        new Request(`http://h${path}`, {
          method: "POST",
          ...(contentType ? { headers: { "content-type": contentType } } : {}),
          body: "{}",
        }),
      );
    expect((await post("/invoke", "text/plain")).status).toBe(415);
    expect((await post("/invoke")).status).toBe(415);
    expect((await post("/control/anything", "text/plain")).status).toBe(415); // the mount too
    expect(ran).toEqual([]);
    // The channel's own route is untouched, whatever it posts.
    expect(await (await post("/telegram", "application/x-www-form-urlencoded")).text()).toBe("a platform's");
  });

  it("an UNPUBLISHED serve allows loopback origins only — the one port a browser is the sole route to", async () => {
    // Not a lock we add: the browser already denies a cross-origin read by default, and `*` would be
    // us REMOVING that on behalf of a port an attacker cannot otherwise reach at all. Vite shipped the
    // wildcard in this exact posture (CVE-2025-24010), over source code rather than tool authority.
    const handle = build();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "https://[::1]:8443"]) {
      expect((await preflight(handle, "/invoke", origin)).headers.get("access-control-allow-origin")).toBe(origin);
    }
    for (const origin of ["https://evil.example.com", "http://192.168.1.5:5173", "null", "not-a-url"]) {
      const res = await preflight(handle, "/invoke", origin);
      expect({ origin, allowed: res.headers.get("access-control-allow-origin") }).toEqual({ origin, allowed: null });
      // Not a 204 either: a refused preflight must not read as an allowance.
      expect(res.status).not.toBe(204);
    }
  });

  it("http.cors REPLACES the default rather than adding to it — one value, one meaning", async () => {
    // The knob points both ways (widen an unpublished serve, narrow a published one), so it cannot
    // also be conditional about what it starts from. A dev serve that still wants its own loopback
    // page lists it.
    const named = build(["https://app.example.com"]);
    expect(
      (await preflight(named, "/invoke", "https://app.example.com")).headers.get("access-control-allow-origin"),
    ).toBe("https://app.example.com");
    expect(
      (await preflight(named, "/invoke", "http://localhost:5173")).headers.get("access-control-allow-origin"),
    ).toBeNull();
    // `*` is how a deployment that has fronted its port says so out loud.
    expect(
      (await preflight(build(["*"]), "/invoke", "https://evil.example.com")).headers.get("access-control-allow-origin"),
    ).toBe("*");
  });

  it("a page we do not allow is simply not answered — no headers, and no refusal either", async () => {
    // The shape Ollama and Vite's post-CVE default both take: unmatched origin gets nothing, the
    // request itself is left alone. Refusing here would mean policing same-origin writes too (a
    // browser sends `Origin` on those), which is what forced an earlier version to special-case the
    // serve's own hostname. What makes omission SAFE is that a route of ours refuses a body that is
    // not application/json, so a cross-origin simple request never reaches a turn — asserted where
    // that gate lives (test/http.test.ts, test/control-http.test.ts).
    const handle = build();
    const post = (origin: string) =>
      handle(
        new Request("http://h/invoke", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ session: "s", text: "hi" }),
        }),
      );
    const foreign = await post("https://evil.example.com");
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    expect(foreign.status).not.toBe(403);
    // Same-origin and loopback pages are answered, and neither needs a rule of its own.
    ran = [];
    expect((await post("http://localhost:5173")).headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect(ran).toEqual(["invoke"]);
    // A non-browser client sends no Origin and is untouched by the ORIGIN rule — but the JSON gate is
    // about the route, not the caller, so curl declares its body like everyone else.
    ran = [];
    const curl = await handle(
      new Request("http://h/invoke", { method: "POST", headers: { "content-type": "application/json" } }),
    );
    expect({ status: curl.status, ran }).toEqual({ status: 200, ran: ["invoke"] });
  });

  it("ownership is per route KEY: a channel beside us on the same path is still the channel's", async () => {
    // `routesFor` reserves `POST /invoke` only, so a channel may legally serve `GET /invoke`. By path
    // alone that route would inherit the CORS headers — a channel route made browser-callable by a
    // rule that was never about it.
    ran = [];
    const handle = router(
      { "POST /invoke": () => new Response("ours") },
      { "GET /invoke": () => new Response("a channel's") },
    );
    const local = { origin: "http://localhost:5173" };
    const channelRoute = await handle(new Request("http://h/invoke", { headers: local }));
    expect(await channelRoute.text()).toBe("a channel's");
    expect(channelRoute.headers.get("access-control-allow-origin")).toBeNull();
    // …and a foreign origin is not refused on it either: nothing about it is ours to police.
    const foreign = await handle(new Request("http://h/invoke", { headers: { origin: "https://evil.example.com" } }));
    expect({ status: foreign.status, body: await foreign.text() }).toEqual({ status: 200, body: "a channel's" });
    // Ours on the same path is unaffected.
    expect(
      (await handle(new Request("http://h/invoke", { method: "POST", headers: local }))).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("http://localhost:5173");
  });

  it("a request with no Origin is not a browser request: no CORS headers, nothing refused", async () => {
    const handle = build();
    const res = await handle(
      new Request("http://h/invoke", { method: "POST", headers: { "content-type": "application/json" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("serve: router", () => {
  const routes: Routes = {
    "POST /webhook": () => new Response("hook", { status: 202 }),
    "GET /health": () => new Response("ok"),
    "/any": () => new Response("any-method"),
  };
  const handle = router({}, routes);
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
    expect(() => router({}, { " /x": () => new Response("x") })).toThrow(/leading space is not a method/);
    expect(parseRouteKey("/x")).toEqual({ path: "/x" });
    expect(parseRouteKey("GET /x")).toEqual({ method: "GET", path: "/x" });
    const handle = router({}, { "/any": () => new Response("any-method") });
    expect((await handle(new Request("http://h/any", { method: "DELETE" }))).status).toBe(200);
  });

  it("an unusual method is a route like any other — the client's limits are not ours", async () => {
    // `fetch` refuses to CONSTRUCT a TRACE request, which is a client-side rule. A server still
    // receives one over a raw socket, so refusing the route here would remove a working capability
    // to describe someone else's limitation.
    const check = (key: string) => () => assertRouteKey(key, (problem) => `bad: ${problem}`);
    expect(check("PROPFIND /x")).not.toThrow(); // extension methods are ordinary
    const handle = router({}, { "TRACE /x": () => new Response("traced") });
    expect(await (await handle(new Request("http://h/x", { method: "GET" }))).status).toBe(405);
    const raw = new Request("http://h/x");
    Object.defineProperty(raw, "method", { value: "TRACE" });
    expect(await (await handle(raw)).text()).toBe("traced");
  });

  it("a lower-case method is the same route, and reaches its handler", async () => {
    // The method is upper-cased when the key is parsed, so validation and conflict-checking already
    // agree that `"get /x"` is `GET /x`. Dispatch has to agree too, or the route starts and never runs.
    const handle = router({}, { "get /x": () => new Response("hit") });
    expect(await (await handle(new Request("http://h/x"))).text()).toBe("hit");
    expect(() => router({}, { "get /x": () => new Response("a"), "GET /x": () => new Response("b") })).toThrow(
      /conflicts/,
    );
  });

  it("router() refuses two keys that name the same route", () => {
    // The object's own key uniqueness does not catch this: `"/x"` and `"GET /x"` are different keys
    // for the same request, and registration order would silently pick a winner.
    expect(() => router({}, { "/x": () => new Response("a"), "GET /x": () => new Response("b") })).toThrow(/conflicts/);
    // Distinct methods on one path are the normal case and must stay legal.
    expect(() => router({}, { "GET /x": () => new Response("a"), "POST /x": () => new Response("b") })).not.toThrow();
  });

  it("routeKeysConflict compares, it does not predict", () => {
    expect(routeKeysConflict("GET /x", "POST /x")).toBe(false); // same path, different methods
    expect(routeKeysConflict("GET /x", "GET /x")).toBe(true);
    expect(routeKeysConflict("/x", "GET /x")).toBe(true); // no method answers every method
    expect(routeKeysConflict("POST /a", "POST /b")).toBe(false);
  });

  it("a route inside a mount is refused — the mount owns everything beneath it", async () => {
    const plane = { prefix: "/control", handler: () => new Response("plane") };
    expect(() => router({}, { "GET /control/mine": () => new Response("x") }, [plane])).toThrow(/inside the mount/);
    expect(() => router({}, { "GET /control": () => new Response("x") }, [plane])).toThrow(/inside the mount/);
    expect(() => router({}, { "GET /controlled": () => new Response("x") }, [plane])).not.toThrow();
    // And the mount actually serves its prefix, including paths it does not itself route.
    const handle = router({}, { "GET /telegram": () => new Response("tg") }, [plane]);
    expect(await (await handle(new Request("http://h/control/anything"))).text()).toBe("plane");
    expect(await (await handle(new Request("http://h/control"))).text()).toBe("plane");
    expect(await (await handle(new Request("http://h/telegram"))).text()).toBe("tg");
  });

  it("a mount prefix is held to the same path rule as a route key", () => {
    // A prefix IS a path. Unchecked, `/files/:id` would be resolved by the matcher its own way while
    // pathUnderPrefix compared it as a literal — the exact split this language exists to close.
    const mount = (prefix: string) => () => router({}, {}, [{ prefix, handler: () => new Response("m") }]);
    expect(mount("control")).toThrow(/must start/);
    expect(mount("/control/")).toThrow(/no trailing slash/);
    expect(mount("/")).toThrow(/owning every path IS that handler/); // the root is not a mount
    expect(mount("/control")).not.toThrow();
  });

  it("even the router's own 404 and 405 carry no content for HEAD", async () => {
    // These are written by the router, not by a handler — the earlier version stripped only handler
    // replies, so the one function had two HEAD semantics depending on who answered.
    const handle = router({}, { "POST /x": () => new Response("x") });
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
    const handle = router({}, {}, [{ prefix: "/p", handler: () => new Response("mount-body") }]);
    const head = await handle(new Request("http://h/p/x", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(await (await handle(new Request("http://h/p/x"))).text()).toBe("mount-body");
  });

  it("two mounts may not claim the same ground", () => {
    const at = (prefix: string) => ({ prefix, handler: () => new Response(prefix) });
    expect(() => router({}, {}, [at("/control"), at("/control/admin")])).toThrow(/overlaps/);
    expect(() => router({}, {}, [at("/control"), at("/control")])).toThrow(/overlaps/);
    expect(() => router({}, {}, [at("/control"), at("/controlled")])).not.toThrow();
    expect(() => router({}, {}, [at("/a"), at("/b")])).not.toThrow();
  });

  it("HEAD is answered from GET without the content, whichever route answers — and an explicit HEAD wins", async () => {
    // RFC 9110. Dropped here rather than left to the HTTP layer, because this handler is public
    // surface: a caller invoking it directly must get the same answer the socket would carry.
    const fromGet = router({}, { "GET /x": () => new Response("body", { headers: { "x-mark": "1" } }) });
    const head = await fromGet(new Request("http://h/x", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("x-mark")).toBe("1"); // headers survive; only the content goes
    expect(await head.text()).toBe("");
    // Not only the GET fallback: an explicit HEAD route and a method-less one are HEAD responses too.
    const explicitOnly = router({}, { "HEAD /x": () => new Response("should not ship") });
    expect(await (await explicitOnly(new Request("http://h/x", { method: "HEAD" }))).text()).toBe("");
    const anyMethod = router({}, { "/x": () => new Response("should not ship") });
    expect(await (await anyMethod(new Request("http://h/x", { method: "HEAD" }))).text()).toBe("");
    expect(await (await anyMethod(new Request("http://h/x"))).text()).toBe("should not ship"); // GET unaffected
    // Writing one explicitly is allowed, and takes precedence — nothing here is unreachable.
    const explicit = router(
      {},
      {
        "GET /x": () => new Response("get"),
        "HEAD /x": () => new Response("", { headers: { "x-who": "head" } }),
      },
    );
    expect((await explicit(new Request("http://h/x", { method: "HEAD" }))).headers.get("x-who")).toBe("head");
  });

  it("router() enforces the language too, not just the channel loader", () => {
    // Two doors lead to the matcher: channel files, and an embedder handing over `Routes`. A pattern
    // slipping through the second one would match at runtime while every collision check — which
    // reads paths as literals — quietly answers the wrong question about it.
    expect(() => router({}, { "GET /x?y=1": () => new Response("x") })).toThrow(/arrives as/);
    expect(() => router({}, { " /x": () => new Response("x") })).toThrow(/leading space/);
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
