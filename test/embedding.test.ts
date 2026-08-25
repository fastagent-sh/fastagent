/**
 * The embedding contract, run against the real frameworks it names.
 *
 * `docs/embedding.md` tells an author to mount fastagent inside an app they already have, on the
 * server they already run. Those snippets are load-bearing — someone copies them into a codebase —
 * and every one of them crosses the Node/Fetch seam through `nodeListener`, whose implementation is
 * not ours (it wraps `@hono/node-server`). A swap underneath can keep every unit test green while
 * breaking the paste-this-in path, which is exactly how it went unnoticed until it was checked by
 * hand: the file is the regression net for those snippets.
 *
 * Express and Fastify are devDependencies for this reason alone. They stand in for the two shapes
 * that exist — a framework that hands you `(req, res)`, and one that hands you a reply you must
 * hijack first — so a third framework is covered by whichever it resembles, not by a third suite.
 */
import express from "express";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { nodeListener, router } from "../src/channels/serve.ts";

/** The handler shape every snippet bridges: reads the RAW body, answers with what it saw. */
const echoRaw = async (req: Request) => new Response(`raw=[${await req.text()}]`);

const started: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of started.splice(0)) await stop();
  vi.restoreAllMocks();
});

/** Start an Express app on an ephemeral port and register its teardown. */
async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1") as Server;
  await new Promise<void>((r) => server.once("listening", r));
  started.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, body: string) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });

describe("embedding: Express", () => {
  it("mounts a single route, exactly as documented", async () => {
    // docs/embedding.md — `app.post("/chat", nodeListener(handler));`
    const app = express();
    app.post("/chat", nodeListener(echoRaw));
    const base = await listen(app);
    expect(await (await post(`${base}/chat`, '{"a":1}')).text()).toBe('raw=[{"a":1}]');
  });

  it("mounts the whole route table under a prefix, on the app's own server", async () => {
    // The other half of the promise: not "a handler", but every channel the agent declares —
    // one server, one port, the prefix chosen by the embedder.
    const app = express();
    const seen: string[] = [];
    app.use((req, _res, next) => {
      seen.push(`${req.method} ${req.url}`);
      next();
    });
    app.get("/mine", (_req, res) => {
      res.send("the app's own route");
    });
    app.use(
      "/agent",
      nodeListener(router({ "POST /telegram": echoRaw, "GET /health": async () => new Response("ok") })),
    );

    const base = await listen(app);
    expect(await (await fetch(`${base}/mine`)).text()).toBe("the app's own route");
    expect(await (await post(`${base}/agent/telegram`, "hi")).text()).toBe("raw=[hi]");
    expect(await (await fetch(`${base}/agent/health`)).text()).toBe("ok");
    // Unknown paths under the prefix are OURS to answer, and must not leak into the app's routing.
    expect((await fetch(`${base}/agent/nope`)).status).toBe(404);
    // The embedder's middleware still runs for fastagent's routes — mounting must not opt out of it.
    expect(seen).toContain("POST /agent/telegram");
  });

  it("mount-before-parser is the documented order, and the wrong one says why", async () => {
    // docs/embedding.md's note. Node's request is one-shot: a parser registered FIRST consumes it
    // and the agent gets nothing — with webhook signatures computed over the raw bytes, this is a
    // silent integration outage, so the failure has to name its own fix.
    const good = express();
    good.use("/agent", nodeListener(echoRaw));
    good.use(express.json());
    good.post("/mine", (req, res) => {
      res.json({ parsed: req.body });
    });
    const goodBase = await listen(good);
    expect(await (await post(`${goodBase}/agent/hook`, '{"a":1}')).text()).toBe('raw=[{"a":1}]');
    // ...and the app's own routes still get their parsed body.
    expect(await (await post(`${goodBase}/mine`, '{"a":1}')).json()).toEqual({ parsed: { a: 1 } });

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const bad = express();
    bad.use(express.json());
    bad.use("/agent", nodeListener(echoRaw));
    const badBase = await listen(bad);
    const res = await post(`${badBase}/agent/hook`, '{"a":1}');
    expect(res.status).toBe(500);
    expect(errors.join("\n")).toMatch(/mount fastagent BEFORE the body parser/);
    expect(await res.text()).not.toMatch(/express|middleware/); // internals stay internal
  });

  it("scoping the parser away from the mount works too", async () => {
    const app = express();
    app.use("/other", express.json());
    app.use("/agent", nodeListener(echoRaw));
    const base = await listen(app);
    expect(await (await post(`${base}/agent/hook`, '{"a":1}')).text()).toBe('raw=[{"a":1}]');
  });
});

describe("embedding: Fastify", () => {
  it("bridges on the raw req/res after hijacking the reply, exactly as documented", async () => {
    // docs/embedding.md — removeAllContentTypeParsers + a pass-through parser keep the stream
    // unread; hijack() hands the response back to us. Every step is load-bearing, which is why the
    // snippet is reproduced here verbatim rather than paraphrased.
    const app = Fastify();
    await app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
      scope.post("/chat", (req, reply) => {
        reply.hijack();
        nodeListener(echoRaw)(req.raw, reply.raw);
      });
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    started.push(() => app.close());
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    expect(await (await post(`${base}/chat`, '{"a":1}')).text()).toBe('raw=[{"a":1}]');
  });

  it("keeping Fastify's default parsers eats the body, and says so", async () => {
    // The mirror of Express's wrong order: Fastify parses application/json by default, so a route
    // that forgets `removeAllContentTypeParsers` hits the same one-shot stream.
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const app = Fastify();
    app.post("/chat", (req, reply) => {
      reply.hijack();
      nodeListener(echoRaw)(req.raw, reply.raw);
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    started.push(() => app.close());
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    expect((await post(`${base}/chat`, '{"a":1}')).status).toBe(500);
    expect(errors.join("\n")).toMatch(/already read by upstream middleware/);
  });
});
