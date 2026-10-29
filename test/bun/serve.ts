/**
 * `serveHandler`'s host contract on Bun, where vitest does not run: CI's Bun job runs this file
 * (`bun test/bun/serve.ts`), and test/serve-routes.test.ts holds the same contract on Node. What bounds a close on
 * either runtime is the server's graceful-shutdown timeout.
 */
import type { Agent } from "../../src/agent-api.ts";
import { serveHandler } from "../../src/channels/serve.ts";
import { apiHandler } from "../../src/http/server.ts";

if (typeof process.versions.bun !== "string") throw new Error("run this with bun: bun test/bun/serve.ts");

const failures: string[] = [];
function check(label: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "ok  " : "FAIL"} ${label}${pass ? "" : `: ${detail}`}`);
  if (!pass) failures.push(label);
}

{
  const NativeResponse = globalThis.Response;
  const host = serveHandler(async () => new NativeResponse("held"), { port: 0 });
  const port = await host.listening;
  const res = await fetch(`http://127.0.0.1:${port}/x`);
  const body = await res.text();
  check("serves, leaving the global Response alone", globalThis.Response === NativeResponse && body === "held", body);
  await host.close();
}
{
  const first = serveHandler(() => new Response("ok"), { port: 0, host: "127.0.0.1" });
  const taken = await first.listening;
  const second = serveHandler(() => new Response("ok"), { port: taken, host: "127.0.0.1" });
  const outcome = await second.listening.then(
    () => "it listened",
    (error: NodeJS.ErrnoException) => `${error.code ?? ""} ${error.message}`,
  );
  check("a bind failure rejects `listening` with the runtime's own error", /EADDRINUSE/.test(outcome), outcome);
  await first.close();
}
{
  const host = serveHandler(() => new Response("ok"), { port: 0, host: "127.0.0.1" });
  const port = await host.listening;
  const other = await fetch(`http://127.0.0.2:${port}/`, { signal: AbortSignal.timeout(2000) }).then(
    () => "served",
    () => "refused",
  );
  check("binds only the given host", other === "refused", other);
  await host.close();
}
{
  let entered!: () => void;
  const handling = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const host = serveHandler(
    async () => {
      entered();
      await new Promise<never>(() => {});
      return new Response();
    },
    { port: 0 },
  );
  const port = await host.listening;
  const request = fetch(`http://127.0.0.1:${port}/`).then(
    (res) => `answered ${res.status}`,
    (error: unknown) => `errored ${String(error)}`,
  );
  await handling;
  const started = Date.now();
  const closing = host.close().then(() => `closed in ${Date.now() - started}ms`);
  const closed = await Promise.race([
    closing,
    new Promise<string>((resolve) => setTimeout(() => resolve("still closing after 2 s"), 2000)),
  ]);
  check(
    "closing with a request that never answers finishes",
    closed.startsWith("closed"),
    `${closed}; ${await request}`,
  );
}

{
  const host = serveHandler(() => new Response("ok"), { port: 0 });
  await host.close();
  const outcome = await host.listening.then(
    (port) => `listened on ${port}`,
    (error: Error) => error.message,
  );
  check("closing before it listened binds nothing", /closed before it listened/.test(outcome), outcome);
}

{
  // An Agent API event stream says nothing between its events for longer than Bun's own idle timeout (10 s).
  const session = { id: "s", status: "idle", usage: { models: {}, tools: {} } };
  const agent = {
    sessions: {
      events: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "state", session };
          await new Promise((resolve) => setTimeout(resolve, 12_000));
          yield { type: "state", session };
          await new Promise(() => {});
        },
      }),
    },
  } as unknown as Agent;
  const api = apiHandler(agent, { keys: ["key"], keepAliveMs: 30_000 });
  const host = serveHandler(api.fetch, { port: 0, host: "127.0.0.1" });
  const port = await host.listening;
  const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/s/events`, {
    headers: { authorization: "Bearer key" },
  });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let received = "";
  const outcome = await (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return "it ended";
        received += new TextDecoder().decode(value);
        if ((received.match(/event: state/g) ?? []).length === 2) return "both events";
      }
    } catch (error) {
      return `cut: ${String(error)}`;
    }
  })();
  check("an event stream quiet for 12 s is not cut", outcome === "both events", outcome);
  await api.endStreams();
  await host.close();
  await api.dispose();
}

if (failures.length > 0) {
  console.error(`${failures.length} of the host contract failed on Bun ${process.versions.bun}`);
  process.exit(1);
}
process.exit(0);
