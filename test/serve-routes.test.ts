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

describe("serve: the route path language", () => {
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
});
