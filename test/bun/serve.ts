/**
 * `serveNode`'s host contract on Bun, where vitest does not run: CI's Bun job runs this file (`bun test/bun/serve.ts`),
 * and test/serve-routes.test.ts holds the same contract on Node. Bun serves on its own server, which gives no handle
 * to force a connection shut, so what bounds a close there is the server's graceful-shutdown timeout alone.
 */
import { serveNode } from "../../src/channels/serve.ts";

if (typeof process.versions.bun !== "string") throw new Error("run this with bun: bun test/bun/serve.ts");

const failures: string[] = [];
function check(label: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "ok  " : "FAIL"} ${label}${pass ? "" : `: ${detail}`}`);
  if (!pass) failures.push(label);
}

{
  const NativeResponse = globalThis.Response;
  const host = serveNode(async () => new NativeResponse("held"), { port: 0 });
  const port = await host.listening;
  const res = await fetch(`http://127.0.0.1:${port}/x`);
  const body = await res.text();
  check("serves, leaving the global Response alone", globalThis.Response === NativeResponse && body === "held", body);
  await host.close();
}
{
  const first = serveNode(() => new Response("ok"), { port: 0, host: "127.0.0.1" });
  const taken = await first.listening;
  const second = serveNode(() => new Response("ok"), { port: taken, host: "127.0.0.1" });
  const outcome = await second.listening.then(
    () => "it listened",
    (error: NodeJS.ErrnoException) => `${error.code ?? ""} ${error.message}`,
  );
  check("a bind failure rejects `listening` with the runtime's own error", /EADDRINUSE/.test(outcome), outcome);
  await first.close();
}
{
  const host = serveNode(() => new Response("ok"), { port: 0, host: "127.0.0.1" });
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
  const host = serveNode(
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
  host.closeAllConnections();
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
  const host = serveNode(() => new Response("ok"), { port: 0 });
  await host.close();
  const outcome = await host.listening.then(
    (port) => `listened on ${port}`,
    (error: Error) => error.message,
  );
  check("closing before it listened binds nothing", /closed before it listened/.test(outcome), outcome);
}

if (failures.length > 0) {
  console.error(`${failures.length} of the host contract failed on Bun ${process.versions.bun}`);
  process.exit(1);
}
process.exit(0);
