/** MCP-derived URLs stay public unless they address the explicitly declared local endpoint. */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { fromPromise, originalError } from "../promise-bridge.ts";
import { McpError } from "../mcp-api.ts";
import { checkMcpUrl } from "./config.ts";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
blocked.addAddress("168.63.129.16", "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const mappedV4 = new BlockList();
mappedV4.addSubnet("0.0.0.0", 0, "ipv4");
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
const hostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");
const localName = (name: string) => /(^|\.)localhost\.?$/i.test(name);

function allowedAddress(declared: URL, target: URL, address: string): boolean {
  const version = isIP(address);
  if (!version) return false;
  const family = version === 4 ? "ipv4" : "ipv6";
  if (
    declared.origin === target.origin &&
    (hostname(declared) === address || (localName(hostname(declared)) && loopback.check(address, family)))
  )
    return true;
  return (
    !blocked.check(address, family) &&
    (version === 4 || mappedV4.check(address, family) || globalV6.check(address, family))
  );
}

function denied(): never {
  throw new McpError("authorization_mismatch", "MCP network policy refused an undeclared non-public destination");
}

export function checkMcpTarget(serverUrl: string, value: string): URL {
  const declared = checkMcpUrl(serverUrl);
  const target = checkMcpUrl(value);
  const host = hostname(target);
  if (isIP(host) ? !allowedAddress(declared, target, host) : localName(host) && target.origin !== declared.origin)
    denied();
  return target;
}

export function mcpFetch(
  serverUrl: string,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs = 30_000,
): typeof globalThis.fetch {
  return (input, init) => {
    checkMcpTarget(serverUrl, input instanceof Request ? input.url : String(input));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  };
}

type Lookup = (host: string) => Promise<readonly { address: string; family: number }[]>;
export interface McpNetwork {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

export async function openMcpNetwork(
  serverUrl: string,
  customFetch?: typeof globalThis.fetch,
  resolve: Lookup = (host) => lookup(host, { all: true, order: "ipv4first" }),
): Promise<McpNetwork> {
  if (customFetch) return { fetch: mcpFetch(serverUrl, customFetch, 60_000), close: async () => {} };
  // Bun's bare undici shim ignores dispatcher factories; load the installed implementation on both runtimes.
  const { EnvHttpProxyAgent, Pool, fetch } = await import("undici/index.js");
  const { noProxyList } = await import("../proxy.ts");
  const declared = checkMcpUrl(serverUrl);
  const pins = new Map<string, URL>();
  let closed = false;
  const dispatcher = new EnvHttpProxyAgent({
    noProxy: noProxyList(),
    proxyTunnel: true,
    factory: (origin, options) => {
      const authority = new URL(origin);
      const target = pins.get(authority.origin);
      if (!target) return denied();
      // fetch removes Host; restore the original authority only after it selects this pinned pool.
      return new Pool(target, options).compose(
        (dispatch) => (request, handler) =>
          dispatch(
            {
              ...request,
              headers: Array.isArray(request.headers)
                ? ["host", authority.host, ...request.headers]
                : { ...request.headers, host: authority.host },
            },
            handler,
          ),
      );
    },
  });
  const request: typeof globalThis.fetch = async (input, init) => {
    if (closed) throw new McpError("connection", "MCP network is closed");
    const request = new Request(input, init);
    const url = checkMcpTarget(serverUrl, request.url);
    if (!pins.has(url.origin)) {
      const resolved = await Effect.runPromiseExit(
        fromPromise(async () => {
          const host = hostname(url);
          const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
          const first = addresses[0];
          if (!first || addresses.some(({ address }) => !allowedAddress(declared, url, address))) return denied();
          const pinned = new URL(url.origin);
          const address = first.address;
          pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
          return pinned;
        }),
        { signal: request.signal },
      );
      if (Exit.isFailure(resolved)) {
        request.signal.throwIfAborted();
        throw originalError(resolved.cause);
      }
      pins.set(url.origin, resolved.value);
    }
    request.signal.throwIfAborted();
    if (closed) throw new McpError("connection", "MCP network is closed");
    const headers = new Headers(request.headers);
    if (headers.has("host") && headers.get("host") !== url.host)
      throw new McpError("configuration", "MCP Host header must match the declared URL");
    return (await fetch(request.url, {
      dispatcher,
      method: request.method,
      headers: [...headers],
      signal: request.signal,
      body: request.body,
      duplex: "half",
      redirect: "error",
    })) as unknown as Response;
  };
  return {
    fetch: mcpFetch(serverUrl, request, 60_000),
    close: async () => {
      closed = true;
      await dispatcher.destroy();
    },
  };
}
