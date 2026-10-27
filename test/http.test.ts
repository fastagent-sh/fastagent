/**
 * The node:http binding of a Fetch handler (channels/serve.ts): the bridge itself, whatever handler it serves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { nodeListener, serveNode } from "../src/index.ts";

type Handler = (req: Request) => Promise<Response>;
interface Served {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * The two ways a Fetch handler reaches a socket: an app's own `node:http` server through `nodeListener`, and the
 * server `dev`, `start` and AgentCore serve on (`serveNode`). The host contract below holds for both, through a real
 * socket, so it survives swapping either bridge.
 */
const bridges: Record<string, (handler: Handler) => Promise<Served>> = {
  nodeListener: async (handler) => {
    const server = createServer(nodeListener(handler));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://localhost:${port}`,
      port,
      async close() {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  },
  serveNode: async (handler) => {
    const host = serveNode(handler, { port: 0 });
    const port = await host.listening;
    return {
      url: `http://localhost:${port}`,
      port,
      async close() {
        const closing = host.close();
        host.closeAllConnections();
        await closing;
      },
    };
  },
};

describe.each(Object.entries(bridges))("%s: bridging a Fetch handler", (_, serving) => {
  it("bridges a streamed response chunk by chunk, with the request's method, path and body", async () => {
    const srv = await serving(async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/echo") return new Response("nope\n", { status: 404 });
      const body = await req.text();
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${req.method} ${body}\n\n`));
            controller.enqueue(encoder.encode("data: done\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    try {
      const res = await fetch(`${srv.url}/echo`, { method: "POST", body: "hi" });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(await res.text()).toBe("data: POST hi\n\ndata: done\n\n");
      expect((await fetch(`${srv.url}/other`)).status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it("a handler that returns a non-Response (forgot to return) yields 500, not a server crash", async () => {
    // The handler is typed (req) => Promise<Response>, but loadChannels loads arbitrary user code: a channel
    // that forgets to return (undefined) makes response.headers undefined — a TypeError in the gap BETWEEN
    // the old handler-catch and the stream-try. pump is TOTAL, so this fails into a 500, never escaping as
    // the unhandled rejection that would crash the server (a crash would hang/error this fetch instead).
    const srv = await serving((async () => undefined) as unknown as (req: Request) => Promise<Response>);
    try {
      const res = await fetch(`${srv.url}/x`, { method: "POST", body: "{}" });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("internal error\n");
    } finally {
      await srv.close();
    }
  });

  it("a client that disconnects cancels the response stream, aborts the request's signal, and is no failure", async () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const cancelled = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const srv = await serving(async (req) => {
      // A channel that streams unsubscribes on its request's signal: it must fire after the handler has returned.
      req.signal.addEventListener("abort", () => aborted.resolve());
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            timer = setInterval(() => controller.enqueue(encoder.encode("data: x\n\n")), 5);
          },
          cancel() {
            clearInterval(timer);
            cancelled.resolve();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    try {
      const controller = new AbortController();
      const res = await fetch(`${srv.url}/stream`, { signal: controller.signal });
      await res.body?.getReader().read();
      controller.abort();
      await Promise.race([
        cancelled.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("the stream was never cancelled")), 3000)),
      ]);
      await Promise.race([
        aborted.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("the request's signal never aborted")), 3000)),
      ]);
      await new Promise((r) => setTimeout(r, 20));
      expect(errs.filter((e) => /failed/.test(e))).toEqual([]);
    } finally {
      await srv.close();
    }
  });
});

describe("nodeListener: a body upstream middleware already read", () => {
  afterEach(() => vi.restoreAllMocks());
  const serving = bridges.nodeListener as (handler: Handler) => Promise<Served>;

  it("a drained body is diagnosed with its fix, not with 'Body is unusable'", async () => {
    // The embedding trap: `app.use(express.json())` ahead of the mount eats the one-shot stream.
    // Simulated without a framework — draining `req` first is exactly what a body parser does.
    // What is asserted is the DIAGNOSIS: the adapter's native error names only the symptom, and a
    // webhook channel failing this way looks like a broken integration with a retrying platform.
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const listener = nodeListener(async (req) => new Response(await req.text()));
    const server = createServer(async (req, res) => {
      await new Promise<void>((r) => {
        req.resume();
        req.on("end", r);
      });
      listener(req, res);
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/hook`, { method: "POST", body: '{"a":1}' });
      expect(res.status).toBe(500);
      const logged = errs.join("\n");
      expect(logged).toMatch(/already read by upstream middleware/);
      expect(logged).toMatch(/mount fastagent BEFORE the body parser/); // the fix, not just the fault
      expect(await res.text()).not.toMatch(/express|middleware/); // internals stay internal
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a body that was NOT read still reaches the handler (the check must not misfire)", async () => {
    const host = await serving(async (req) => new Response(`got:${await req.text()}`));
    try {
      const res = await fetch(`http://127.0.0.1:${host.port}/hook`, { method: "POST", body: "payload" });
      expect(await res.text()).toBe("got:payload");
      // ...and a GET, whose body is absent rather than eaten, must not trip it either.
      expect((await fetch(`http://127.0.0.1:${host.port}/plain`)).status).toBe(200);
    } finally {
      await host.close();
    }
  });

  it("an empty CHUNKED post behind middleware is not mistaken for an eaten one", async () => {
    // Chunked framing says nothing about content: an empty chunked body is legal, arrives already
    // drained, and looks exactly like an eaten one. The guard must stay quiet rather than reject a
    // valid request — being wrong here turns a diagnostic into the outage.
    const listener = nodeListener(async (req) => new Response(`ok:[${await req.text()}]`));
    const server = createServer(async (req, res) => {
      await new Promise<void>((r) => {
        req.resume();
        req.on("end", r);
      });
      listener(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const raw = await new Promise<string>((resolve) => {
        const sock = connect(port, "127.0.0.1", () => {
          sock.write("POST /x HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
        });
        let out = "";
        sock.on("data", (d) => {
          out += String(d);
        });
        setTimeout(() => {
          sock.destroy();
          resolve(out);
        }, 250);
      });
      expect(raw.split("\r\n")[0]).toMatch(/200 OK/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("an EMPTY post behind middleware is not mistaken for an eaten one", async () => {
    // `content-length: 0` plus a drained stream looks identical to the eaten case on the two signals
    // the guard reads — but nothing was lost, and rejecting it would make the guard the outage.
    const listener = nodeListener(async (req) => new Response(`ok:[${await req.text()}]`));
    const server = createServer(async (req, res) => {
      await new Promise<void>((r) => {
        req.resume();
        req.on("end", r);
      });
      listener(req, res);
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/x`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok:[]");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe.each(Object.entries(bridges))("%s: the host survives arbitrary channel code", (_, serving) => {
  afterEach(() => vi.restoreAllMocks());

  it("a throwing handler is logged, and says nothing else", async () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const host = await serving(async () => {
      throw new Error("boom /etc/secret-path");
    });
    try {
      const res = await fetch(`http://127.0.0.1:${host.port}/x`);
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(errs.some((e) => /request failed.*boom/.test(e))).toBe(true); // visible in the log
      expect(body).not.toMatch(/etc\/secret-path/); // ...and nowhere else
    } finally {
      await host.close();
    }
  });

  it("a handler that returns a Response whose body it already read is a 500 the log explains", async () => {
    // A channel that read its own Response, or returns one Response it built once for every request.
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errs.push(args.map(String).join(" "));
    });
    const host = await serving(async () => {
      const read = new Response("once");
      await read.text();
      return read;
    });
    try {
      const res = await fetch(`http://127.0.0.1:${host.port}/x`);
      expect(res.status).toBe(500);
      expect(errs.join("\n")).toMatch(/locked|unusable|disturbed|already/i);
    } finally {
      await host.close();
    }
  });

  it("a client that disconnects mid-handler leaves the server serving the next request", async () => {
    // The dead-socket case: the client is gone before the handler resolves. Writing to that socket
    // throws inside the bridge, and an escaped throw would take the process down — so the proof is
    // that the NEXT request still gets served.
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const host = await serving(async (req) => {
      if (new URL(req.url).pathname === "/slow") {
        await slow;
        return new Response("too late");
      }
      return new Response("alive");
    });
    try {
      const ac = new AbortController();
      const dropped = fetch(`http://127.0.0.1:${host.port}/slow`, { signal: ac.signal }).catch(() => "aborted");
      await new Promise((r) => setTimeout(r, 20));
      ac.abort(); // client vanishes while the handler is still awaiting
      expect(await dropped).toBe("aborted");
      releaseSlow(); // handler now resolves into a socket nobody is reading

      await new Promise((r) => setTimeout(r, 20));
      expect(await (await fetch(`http://127.0.0.1:${host.port}/next`)).text()).toBe("alive");
    } finally {
      await host.close();
    }
  });

  it("a body stream that errors mid-flight surfaces and does not crash the server", async () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const host = await serving(async (req) => {
      if (new URL(req.url).pathname === "/boom") {
        let n = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (n++ === 0) c.enqueue(new TextEncoder().encode("data: x\n\n"));
              else throw new Error("stream blew up mid-flight");
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("alive");
    });
    try {
      // Reading is only the TRIGGER; a truncated body is the expected shape of this failure, so
      // the read itself is allowed to throw. What is asserted is what happens on the SERVER.
      let delivered = "";
      await (async () => {
        const res = await fetch(`http://127.0.0.1:${host.port}/boom`);
        const reader = res.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (value) delivered += new TextDecoder().decode(value);
          if (done) return;
        }
      })().catch(() => undefined);
      // Rule 8: the failure is visible...
      await new Promise((r) => setTimeout(r, 30));
      expect(errs.some((e) => /blew up mid-flight|request failed/.test(e))).toBe(true);
      // ...and the server is still there.
      expect(await (await fetch(`http://127.0.0.1:${host.port}/next`)).text()).toBe("alive");
      // The failure must not be told to the CLIENT: once headers are out an adapter can only append
      // to the body, and appending the exception text would publish whatever it names.
      expect(delivered).not.toMatch(/blew up mid-flight/);
    } finally {
      await host.close();
    }
  });

  it("a client that disconnects while an endless stream is backpressured does not leak the request", async () => {
    // The leak shape this guards: a writer parked waiting for 'drain' on a socket that closed will
    // never be woken, pinning the stream (and its invoke) forever. Proof is that cancel() runs.
    let cancelled = false;
    const host = await serving(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new TextEncoder().encode(`data: ${"x".repeat(8192)}\n\n`)); // outruns the client
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    try {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${host.port}/endless`, { signal: ac.signal });
      await res.body!.getReader().read(); // start it, then stop reading so the socket backs up
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await new Promise((r) => setTimeout(r, 100));
      expect(cancelled).toBe(true); // the stream was told to stop — no parked writer left behind
    } finally {
      await host.close();
    }
  });
});
