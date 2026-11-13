import { createServer, type RequestListener } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openMcpNetwork, checkMcpTarget } from "../../../src/mcp/network.ts";
import { mcpGrantFile } from "../../../src/mcp/grants.ts";
import { signInMcp } from "../../../src/mcp/sign-in.ts";

const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) vi.stubEnv(key, "");
  vi.stubEnv("no_proxy", "*");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function listen(
  handler: RequestListener = (_request, response) => {
    response.end("ok");
  },
) {
  const server = createServer(handler);
  let connections = 0;
  const sockets = new Set();
  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    connections: () => connections,
    active: () => sockets.size,
  };
}
it.each(["issuer", "resource_metadata"])(
  "refuses a public service's loopback %s before consent or any private request",
  async (hint) => {
    const local = await listen();
    const dir = await mkdtemp(join(tmpdir(), "mcp-network-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const url = "https://public.test/mcp";
    await writeFile(join(dir, "context.json"), JSON.stringify({ mcpServers: { remote: { type: "http", url } } }));
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(String(input));
      if (String(input).includes("oauth-protected-resource"))
        return Response.json({ resource: url, authorization_servers: [local.url] });
      if (String(input) === url)
        return new Response(null, {
          status: 401,
          ...(hint === "resource_metadata"
            ? { headers: { "www-authenticate": `Bearer resource_metadata="${local.url}/metadata"` } }
            : {}),
        });
      return globalThis.fetch(input, init);
    };
    const confirmAuthorization = vi.fn(async () => true);
    await expect(
      signInMcp({
        agentDir: dir,
        server: "remote",
        store: mcpGrantFile(join(dir, "grants.json")),
        fetch,
        interaction: { confirmAuthorization, notify: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: "authorization_mismatch" });
    expect(confirmAuthorization).not.toHaveBeenCalled();
    expect(local.connections()).toBe(0);
    expect(calls.some((value) => value.startsWith(local.url))).toBe(false);
    expect(calls.some((value) => value.includes("oauth-authorization-server"))).toBe(false);
  },
);
it("rejects non-public URL forms and allows only the declared local origin", () => {
  for (const address of [
    "127.0.0.1",
    "2130706433",
    "0x7f000001",
    "localhost",
    "localhost.",
    "x.localhost",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "198.18.0.1",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[fc00::1]",
    "[fe80::1]",
    "[64:ff9b::7f00:1]",
  ]) {
    expect(() => checkMcpTarget("https://public.test/mcp", `https://${address}/metadata`), address).toThrow(
      "non-public",
    );
  }
  expect(checkMcpTarget("http://127.0.0.1:8000/mcp", "http://127.0.0.1:8000/metadata").pathname).toBe("/metadata");
  expect(() => checkMcpTarget("http://127.0.0.1:8000/mcp", "http://127.0.0.1:8001/metadata")).toThrow("non-public");
});
it("rejects private DNS answers, including mixed and mapped answers, before connecting", async () => {
  const local = await listen();
  const target = `https://oauth.test:${local.port}/metadata`;
  for (const addresses of [
    [{ address: "127.0.0.1", family: 4 }],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    [{ address: "::ffff:127.0.0.1", family: 6 }],
    [{ address: "fe80::1", family: 6 }],
  ]) {
    const network = await openMcpNetwork("https://public.test/mcp", undefined, async () => addresses);
    cleanup.push(() => network.close());
    await expect(network.fetch(target)).rejects.toMatchObject({ code: "authorization_mismatch" });
  }
  expect(local.connections()).toBe(0);
});
it("does not follow a redirect even to another permitted local path", async () => {
  const paths: string[] = [];
  const local = await listen((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(302, { location: "/next" }).end();
  });
  const network = await openMcpNetwork(local.url);
  cleanup.push(() => network.close());
  await expect(network.fetch(local.url)).rejects.toMatchObject({ cause: { message: "unexpected redirect" } });
  expect(paths).toEqual(["/"]);
});
