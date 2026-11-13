/** The server a Fetch handler is served on (channels/serve.ts), whatever handler it serves. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveHandler } from "../../../src/channels/serve.ts";

type Handler = (req: Request) => Promise<Response>;
interface Served {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** The server `listen`, `dev`, `start` and AgentCore serve on, through a real socket. */
const serving = async (handler: Handler): Promise<Served> => {
  const host = serveHandler(handler, { port: 0 });
  const port = await host.listening;
  return { url: `http://localhost:${port}`, port, close: () => host.close() };
};

describe("serving a Fetch handler", () => {
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
});

describe("the server survives arbitrary channel code", () => {
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
});
