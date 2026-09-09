/**
 * The ONE reading of a bind address, shared by everything that parses, binds, warns about, or ships one (the CLI flag,
 * `http.host` validation, the Node host, the deploy pre-flight).
 */
import { isIP } from "node:net";

/** Lowercase, unbracketed, IPv4-mapped IPv6 reduced to its IPv4 form — the form the checks below read. */
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
export function classifyBind(host: string | undefined): "wildcard" | "loopback" | "specific" {
  if (host === undefined) return "wildcard";
  const h = normalize(host);
  if (h === "0.0.0.0" || h === "::" || h === "::0") return "wildcard";
  if (h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h)) return "loopback";
  return "specific";
}

/** Does a serve bound to `host` answer a dial of the NAME `localhost`? */
export function answersLocalhost(host: string | undefined): boolean {
  if (classifyBind(host) === "wildcard") return true;
  const h = normalize(host as string);
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/**
 * How to NAME a bind in a message: the wildcard is every interface, so calling it one address would understate it;
 * anything else is dialable as itself.
 */
export function bindLabel(host: string | undefined, port: number): string {
  return classifyBind(host) === "wildcard" ? `port ${port}` : `${clientHost(host)}:${port}`;
}

/** The address a local client should dial for a serve bound to `host` (control.json, the ready log). */
export function clientHost(host: string | undefined): string {
  if (classifyBind(host) === "wildcard") return "127.0.0.1";
  // biome-ignore lint/style/noNonNullAssertion: only a wildcard bind leaves host undefined
  return host!.includes(":") && !host!.startsWith("[") ? `[${host}]` : host!;
}
