import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { installProxyFetch } from "../src/proxy.ts";

/**
 * The egress POLICY itself, in-process: which destinations the installed dispatcher sends through the proxy.
 *
 * This is the level the per-command subprocess tests were standing in for. `installProxyFetch` is process-global and
 * installs once, so this file gets one install and asks it both questions — which is also why the policy lives in one
 * function: a caller cannot ask for half of it.
 */

/** A server that records the request lines it was asked for and answers 200. As a proxy it sees absolute-form URLs
 *  ("http://host/path"); as an origin it sees the path. */
function recordingServer(seen: string[]): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no TCP port"));
      resolve({ server, port: address.port });
    });
  });
}

const proxied: string[] = [];
const direct: string[] = [];
let proxy!: Server;
let origin!: Server;
let originUrl!: string;

beforeAll(async () => {
  const p = await recordingServer(proxied);
  const o = await recordingServer(direct);
  proxy = p.server;
  origin = o.server;
  originUrl = `http://127.0.0.1:${o.port}/local`;
  process.env.HTTP_PROXY = `http://127.0.0.1:${p.port}`;
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
  for (const key of ["NO_PROXY", "no_proxy", "http_proxy", "https_proxy"]) delete process.env[key];
  installProxyFetch();
});

afterAll(async () => {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

describe("installProxyFetch: what the process's fetch does with a declared proxy", () => {
  it("sends an external destination through the proxy", async () => {
    const res = await fetch("http://external.invalid/probe");
    expect(res.status).toBe(200);
    expect(proxied).toContain("http://external.invalid/probe");
  });

  it("leaves loopback direct even though NO_PROXY is unset", async () => {
    // undici's EnvHttpProxyAgent proxies EVERYTHING while NO_PROXY is empty. Without our default, installing a proxy
    // would break this process's own local traffic: health probes, control-plane calls, an `ssh -L` forward.
    const res = await fetch(originUrl);
    expect(res.status).toBe(200);
    expect(direct).toContain("/local");
    expect(proxied.some((url) => url.includes("127.0.0.1"))).toBe(false);
  });
});
