/**
 * The ONE reading of a bind address, shared by everything that parses, binds, warns about, or ships one (the CLI flag,
 * `http.host` validation, the Node host, the deploy pre-flight).
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
export function classifyBind(host: string | undefined): "wildcard" | "loopback" | "specific" {
  if (host === undefined) return "wildcard";
  const h = normalize(host);
  if (h === "0.0.0.0" || h === "::" || h === "::0") return "wildcard";
  if (h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h)) return "loopback";
  return "specific";
}

/**
 * Does a serve bound to `host` answer a dial of the NAME `localhost`? Only the addresses that name resolves to
 * (127.0.0.1 / ::1) and a wildcard bind do — `127.0.0.2` is loopback yet unreachable that way. That is why this is not
 * {@link classifyBind}'s reach question: cloudflared dials by name, so `--tunnel` needs this one.
 */
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

/** The address a local client should dial for a serve bound to `host` (the ready log's curl). */
export function clientHost(host: string | undefined): string {
  if (classifyBind(host) === "wildcard") return "127.0.0.1";
  // biome-ignore lint/style/noNonNullAssertion: only a wildcard bind leaves host undefined
  return host!.includes(":") && !host!.startsWith("[") ? `[${host}]` : host!;
}

/**
 * The names a loopback serve answers to when nothing else is configured — the addresses `localhost` resolves to,
 * plus the name itself.
 */
export const LOOPBACK_HOST_NAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/**
 * May a caller NAME this serve the way it just did? A different question from {@link classifyBind}, which is about
 * the address we listen on: this one is about the `Host` header, and it exists because a browser can be made to
 * send a name that resolves to 127.0.0.1 while the page stays same-origin (DNS rebinding). Same-origin means no
 * `Origin` header and no content-type restriction, so neither guard in `channels/serve.ts` applies and the port —
 * `POST /invoke` with the agent's full tool authority, `/control/*` when it is published — answers a web page with
 * no credential.
 *
 * The REQUEST URL, not the raw header: the Node adapter builds it from `Host`, so this reads the same value with
 * the port already off and an IPv6 literal already bracketed, which is the form the default list is written in.
 */
export function isAllowedHost(requestUrl: string, allowed: readonly string[]): boolean {
  const named = normalize(new URL(requestUrl).hostname);
  return allowed.some((entry) => normalize(entry) === named);
}

/**
 * Refuse a host allow-list that cannot answer anything.
 *
 * An EMPTY list is the spelling worth catching: it reads as "no name may reach this" and would lock the operator
 * out of their own loopback serve with a 403 naming the key they just set.
 */
export function assertAllowedHosts(hosts: unknown, where: string): asserts hosts is string[] {
  if (!Array.isArray(hosts) || hosts.some((h) => typeof h !== "string" || h === "")) {
    throw new Error(`${where} must be an array of host names (e.g. ["localhost", "agent.local"])`);
  }
  if (hosts.length === 0) {
    throw new Error(
      `${where} is empty — list at least the names you reach this serve by (default: localhost, 127.0.0.1, [::1])`,
    );
  }
}
