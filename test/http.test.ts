import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createInvokeHandler, nodeListener, inMemorySessionStore, type Agent, type AgentEvent } from "../src/index.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { makeFaux } from "./faux.ts";

function makeAgent(responses: FauxResponseStep[]): Agent {
  const { faux, models } = makeFaux();
  faux.setResponses(responses);
  return createPiAgentFromHarness({
    harnessFactory: piHarnessFactory({
      sessions: inMemorySessionStore(),
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: faux.getModel(),
      systemPrompt: "test",
    }),
  });
}

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

describe("nodeListener (standalone server bridge)", () => {
  async function startServer(agent: Agent) {
    const handler = createInvokeHandler(agent);
    // Mirror cli.ts serve(): standalone routing lives in the composition root.
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

describe("nodeListener backpressure", () => {
  afterEach(() => vi.restoreAllMocks());
  /** Minimal IncomingMessage: GET (no body) so the bridge needs no request stream. */
  function fakeReq(): IncomingMessage {
    const req = new EventEmitter() as unknown as IncomingMessage & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/invoke";
    req.headers = { host: "localhost" };
    return req;
  }
  /** Minimal ServerResponse whose write() always signals backpressure (returns false). */
  function fakeRes() {
    const res = new EventEmitter() as unknown as ServerResponse & { ended: boolean; destroyed: boolean };
    res.destroyed = false;
    (res as { ended: boolean }).ended = false;
    (res as unknown as { headersSent: boolean }).headersSent = false;
    (res as unknown as { writeHead: () => ServerResponse }).writeHead = () => {
      (res as { headersSent: boolean }).headersSent = true; // real ServerResponse flips this on writeHead
      return res;
    };
    (res as unknown as { write: () => boolean }).write = () => false; // always backpressure
    (res as unknown as { end: () => void }).end = () => {
      (res as { ended: boolean }).ended = true;
    };
    (res as unknown as { destroy: () => void }).destroy = () => {
      (res as { destroyed: boolean }).destroyed = true;
    };
    return res as ServerResponse & { ended: boolean; destroyed: boolean };
  }

  it("catch never writes to an already-destroyed res (client disconnect during the handler await)", async () => {
    // A client that disconnects while pump awaits the handler destroys res (headers not yet sent) and the
    // handler throws (AbortError). The catch must NOT writeHead/end on the dead socket — Node can throw
    // ERR_STREAM_DESTROYED there, which would make the catch itself throw → pump rejects → the very crash.
    // The stub throws if writeHead/end is called on a destroyed res, so a regression re-appears as an
    // unhandled rejection vitest surfaces.
    let touchedDeadSocket = false;
    const res = fakeRes();
    (res as { destroyed: boolean }).destroyed = true; // client already disconnected
    const boom = () => {
      touchedDeadSocket = true;
      throw new Error("ERR_STREAM_DESTROYED");
    };
    (res as unknown as { writeHead: () => ServerResponse }).writeHead = boom as never;
    (res as unknown as { end: () => void }).end = boom as never;
    const handler = (async () => {
      throw new Error("aborted");
    }) as unknown as (req: Request) => Promise<Response>;

    nodeListener(handler)(fakeReq(), res);
    await new Promise((r) => setTimeout(r, 20));
    expect(touchedDeadSocket).toBe(false); // early-returned; never touched the dead socket (so pump didn't reject)
  });

  it("a body stream that errors mid-flight is handled, not an unhandled rejection that crashes the server", async () => {
    // pump is TOTAL: a mid-flight reader error must be caught, logged, and end the response — NEVER escape
    // as an unhandled rejection (pump is void-called; the process has no unhandledRejection handler). If it
    // escaped, vitest would surface the rejection and fail this test.
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const handler = async (): Promise<Response> => {
      let n = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (n++ === 0) c.enqueue(new TextEncoder().encode("data: x\n\n"));
          else throw new Error("stream blew up mid-flight"); // 2nd pull errors the stream
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    };
    const req = fakeReq();
    const res = fakeRes();
    (res as unknown as { write: () => boolean }).write = () => true; // no backpressure — let pump loop to the 2nd (erroring) pull
    nodeListener(handler)(req, res);

    await new Promise((r) => setTimeout(r, 30)); // let pump write once, then hit the erroring pull
    expect(res.destroyed).toBe(true); // destroyed on the stream error
    expect(errs.some((e) => /request failed/.test(e))).toBe(true); // surfaced (rule 8)
  });

  it("client close during backpressure ends pump (no leak; regression for drain-only wait)", async () => {
    // An endless SSE stream so pump always has more to write and parks on backpressure.
    const handler = async (): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(new TextEncoder().encode("data: x\n\n"));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    };
    const req = fakeReq();
    const res = fakeRes();
    nodeListener(handler)(req, res);

    // Let pump start, write once (→ false), and suspend on the backpressure wait.
    await new Promise((r) => setTimeout(r, 20));
    expect(res.ended).toBe(false);

    res.emit("close"); // client disconnects WHILE parked on backpressure (no 'drain' will ever come)

    // With drain+close wait, pump resumes, the cancelled reader yields done, and finally runs end().
    await new Promise((r) => setTimeout(r, 20));
    expect(res.ended).toBe(true);
  });
});
