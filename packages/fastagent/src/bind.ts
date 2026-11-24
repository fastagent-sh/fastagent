/**
 * The ONE reading of a bind address, shared by everything that parses, binds, warns about, or ships one (the CLI flag, the
 * Node host, the startup report).
 */
import { isIP } from "node:net";

/**
 * Lowercase, unbracketed, IPv4-mapped IPv6 reduced to its IPv4 form — the form the checks below read. Brackets come
 * off only as a PAIR: a half-bracketed `[::1` must stay invalid, not become an address.
 */
function normalize(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[(.+)]$/, "$1")
    .replace(/^::ffff:/, "");
}

/** A bindable host: an IP literal (v4/v6, brackets optional) or "localhost". */
export function isBindAddress(host: string): boolean {
  const h = normalize(host);
  return h === "localhost" || isIP(h) !== 0;
}

/**
 * The ADDRESS form of an accepted bind value: `localhost` becomes `127.0.0.1`, everything else is already an address.
 */
export function bindAddress(host: string): string {
  return normalize(host) === "localhost" ? "127.0.0.1" : host;
}

/**
 * How far a bind address reaches: `wildcard` (unset or all-interfaces) reaches every interface and answers on
 * loopback too; `loopback` is this machine only; `specific` is one interface, reachable only as itself.
 */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::", "::0"]);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "::1"]);

export function classifyBind(host: string | undefined): "wildcard" | "loopback" | "specific" {
  if (host === undefined) return "wildcard";
  const h = normalize(host);
  if (WILDCARD_HOSTS.has(h)) return "wildcard";
  if (LOOPBACK_HOSTS.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h)) return "loopback";
  return "specific";
}

/**
 * How to NAME a bind in a message: the wildcard is every interface, so calling it one address would understate it;
 * anything else is dialable as itself.
 */
export function bindLabel(host: string | undefined, port: number): string {
  return classifyBind(host) === "wildcard" ? `port ${port}` : `${clientHost(host)}:${port}`;
}

/** The address a local client should dial for a serve bound to `host` (the ready log's curl). */
function clientHost(host: string | undefined): string {
  if (host === undefined || classifyBind(host) === "wildcard") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
