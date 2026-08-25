import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createInvokeHandler, nodeListener, serveNode, type Agent, type AgentEvent } from "../src/index.ts";
import { INVOKE_EXAMPLE_BODY } from "../src/channels/http.ts";
import { fauxAgent } from "./agent.ts";

const makeAgent = (responses: FauxResponseStep[]): Agent => fauxAgent(responses).agent;

/** Drive the Fetch handler directly (no server) and parse SSE lines into AgentEvent[]. */
async function invoke(
  handler: (req: Request) => Promise<Response>,
  session: string,
  text: string,
): Promise<AgentEvent[]> {
  const res = await handler(
    new Request("http://app/invoke", { method: "POST", body: JSON.stringify({ session, text }) }),
  );
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const body = await res.text();
  return body
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice("data: ".length)) as AgentEvent);
}

describe("invoke handler (Fetch/SSE)", () => {
  it("POST streams text + completed over SSE", async () => {
    const handler = createInvokeHandler(makeAgent([fauxAssistantMessage("hello over http")]));
    const events = await invoke(handler, "s1", "hi");
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as any).delta)
      .join("");
    expect(text).toBe("hello over http");
    expect(events.at(-1)).toEqual({ type: "completed" });
  });

  it("INVOKE_EXAMPLE_BODY (the CLI's \"try it\" hint) satisfies the handler's shape check", async () => {
    // The constant's contract: it lives next to the shape check and must keep passing it — this test
    // is what actually prevents the curl hint from drifting when the protocol changes.
    const handler = createInvokeHandler(makeAgent([fauxAssistantMessage("ok")]));
    const res = await handler(new Request("http://app/invoke", { method: "POST", body: INVOKE_EXAMPLE_BODY }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  it("same-session concurrency: one stream completes, the other receives failed 'session busy'", async () => {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const handler = createInvokeHandler(
      makeAgent([
        async () => {
          started();
          await gate;
          return fauxAssistantMessage("first");
        },
        fauxAssistantMessage("second"),
      ]),
    );
    try {
      const p1 = invoke(handler, "same", "a");
      await ready; // req1 holds the lease
      const e2 = await invoke(handler, "same", "b"); // must be busy now

      expect(e2).toHaveLength(1);
      expect(e2[0]).toMatchObject({ type: "failed", retryable: true });
      expect((e2[0] as any).details).toMatch(/busy/);

      release();
      const e1 = await p1;
      expect(e1.at(-1)?.type).toBe("completed");
    } finally {
      release();
    }
  });

  it("different-session concurrency: both complete", async () => {
    const handler = createInvokeHandler(makeAgent([fauxAssistantMessage("A"), fauxAssistantMessage("B")]));
    const [ea, eb] = await Promise.all([invoke(handler, "a", "x"), invoke(handler, "b", "y")]);
    expect(ea.at(-1)?.type).toBe("completed");
    expect(eb.at(-1)?.type).toBe("completed");
  });

  it("non-POST returns 405; bad/missing body returns 400", async () => {
    const handler = createInvokeHandler(makeAgent([fauxAssistantMessage("x")]));
    expect((await handler(new Request("http://app/invoke", { method: "GET" }))).status).toBe(405);
    expect((await handler(new Request("http://app/invoke", { method: "POST", body: "{not json" }))).status).toBe(400);
    expect(
      (await handler(new Request("http://app/invoke", { method: "POST", body: JSON.stringify({ session: "s" }) })))
        .status,
    ).toBe(400);
  });

  it("oversized body returns 413 before invoke and counts real bytes, not JS characters", async () => {
    const handler = createInvokeHandler(makeAgent([fauxAssistantMessage("x")]));
    const big = await handler(
      new Request("http://app/invoke", {
        method: "POST",
        body: JSON.stringify({ session: "s", text: "x".repeat(2 * 1024 * 1024) }),
      }),
    );
    expect(big.status).toBe(413);
    // 400k emoji = 400k chars but > 1 MiB in bytes → must be rejected
    const multibyte = await handler(
      new Request("http://app/invoke", {
        method: "POST",
        body: JSON.stringify({ session: "s", text: "🙂".repeat(400_000) }),
      }),
    );
    expect(multibyte.status).toBe(413);
  });

  it("consumer cancel runs invoke cleanup (SPEC MUST 3)", async () => {
    let cancelled = false;
    let resolveCancelled!: () => void;
    const cancelledSeen = new Promise<void>((r) => (resolveCancelled = r));
    const fake: Agent = {
      invoke: async function* () {
        let finished = false;
        try {
          for (let i = 0; i < 10_000; i++) {
            yield { type: "text", delta: "x" } as AgentEvent;
            await new Promise((r) => setTimeout(r, 5));
          }
          finished = true;
          yield { type: "completed" } as AgentEvent;
        } finally {
          if (!finished) {
            cancelled = true;
            resolveCancelled();
          }
        }
      },
    };
    const handler = createInvokeHandler(fake);
    const res = await handler(
      new Request("http://app/invoke", { method: "POST", body: JSON.stringify({ session: "s", text: "hi" }) }),
    );
    const reader = res.body!.getReader();
    await reader.read(); // stream has started
    await reader.cancel(); // consumer disconnects
    await Promise.race([
      cancelledSeen,
      new Promise((_, reject) => setTimeout(() => reject(new Error("invoke was never cancelled after cancel")), 3000)),
    ]);
    expect(cancelled).toBe(true);
  });
});

describe("nodeListener (embedded server bridge)", () => {
  async function startServer(agent: Agent) {
    const handler = createInvokeHandler(agent);
    // Mirror cli.ts serve(): embedded routing lives in the composition root.
    const server = createServer(
      nodeListener(async (req) => {
        if (new URL(req.url).pathname !== "/invoke") {
          return new Response("POST /invoke\n", { status: 404, headers: { "content-type": "text/plain" } });
        }
        return handler(req);
      }),
    );
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://localhost:${port}`,
      async close() {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  it("bridges POST /invoke to SSE; wrong path returns 404", async () => {
    const srv = await startServer(makeAgent([fauxAssistantMessage("bridged")]));
    try {
      const res = await fetch(`${srv.url}/invoke`, {
        method: "POST",
        body: JSON.stringify({ session: "s", text: "hi" }),
      });
      const body = await res.text();
      const events = body
        .split("\n\n")
        .filter((b) => b.startsWith("data: "))
        .map((b) => JSON.parse(b.slice("data: ".length)) as AgentEvent);
      const txt = events
        .filter((e) => e.type === "text")
        .map((e) => (e as any).delta)
        .join("");
      expect(txt).toBe("bridged");
      expect(events.at(-1)?.type).toBe("completed");

      const notfound = await fetch(`${srv.url}/other`);
      expect(notfound.status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it("a handler that returns a non-Response (forgot to return) yields 500, not a server crash", async () => {
    // The handler is typed (req) => Promise<Response>, but loadChannels loads arbitrary user code: a channel
    // that forgets to return (undefined) makes response.headers undefined — a TypeError in the gap BETWEEN
    // the old handler-catch and the stream-try. pump is TOTAL, so this fails into a 500, never escaping as
    // the unhandled rejection that would crash the server (a crash would hang/error this fetch instead).
    const badHandler = (async () => undefined) as unknown as (req: Request) => Promise<Response>;
    const server = createServer(nodeListener(badHandler));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://localhost:${port}/x`, { method: "POST", body: "{}" });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("internal error\n");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("client disconnect cancels invoke through the node bridge (SPEC MUST 3)", async () => {
    let cancelled = false;
    let resolveCancelled!: () => void;
    const cancelledSeen = new Promise<void>((r) => (resolveCancelled = r));
    const fake: Agent = {
      invoke: async function* () {
        let finished = false;
        try {
          for (let i = 0; i < 10_000; i++) {
            yield { type: "text", delta: "x" } as AgentEvent;
            await new Promise((r) => setTimeout(r, 5));
          }
          finished = true;
          yield { type: "completed" } as AgentEvent;
        } finally {
          if (!finished) {
            cancelled = true;
            resolveCancelled();
          }
        }
      },
    };
    const handler = createInvokeHandler(fake);
    const server = createServer(nodeListener(handler));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const controller = new AbortController();
      const res = await fetch(`http://localhost:${port}/invoke`, {
        method: "POST",
        body: JSON.stringify({ session: "s", text: "hi" }),
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      await reader.read();
      controller.abort(); // client disconnect
      await Promise.race([
        cancelledSeen,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("invoke was never cancelled after disconnect")), 3000),
        ),
      ]);
      expect(cancelled).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("nodeListener totality (the host must survive arbitrary channel code)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Serve `handler` on a real server and hand back the port. Black-box on purpose: these three
   *  requirements (never crash, never leak, always surface) belong to the HOST CONTRACT, not to any
   *  one bridge implementation — asserted through a real socket, they survive swapping the bridge. */
  async function serving(handler: (req: Request) => Promise<Response>) {
    const server = createServer(nodeListener(handler));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    return {
      port,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

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

  it("the SERVING path has the same boundary: a throwing handler is logged, and says nothing else", async () => {
    // Not a duplicate of the nodeListener case: `dev`/`start` reach the socket through serveNode, so
    // wiring the boundary into only the exported listener would leave the path that actually serves
    // users failing silently — which is how it was first written.
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const host = serveNode(
      async () => {
        throw new Error("boom /etc/secret-path");
      },
      { port: 0 },
    );
    const port = await host.listening;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/x`);
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(errs.some((e) => /request failed.*boom/.test(e))).toBe(true); // visible in the log
      expect(body).not.toMatch(/etc\/secret-path/); // ...and nowhere else
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
