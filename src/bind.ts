/**
 * The ONE reading of a bind address, shared by everything that parses, binds, warns about, or ships
 * one (the CLI flag, `http.host` validation, the Node host, the deploy pre-flight). Engine- and
 * host-neutral on purpose: a bind address is a plain value, and two parsers of it would disagree.
 */
import { isIP } from "node:net";

/** Lowercase, unbracketed, IPv4-mapped IPv6 reduced to its IPv4 form — the form the checks below read.
 *  Brackets come off only as a PAIR: a half-bracketed `[::1` must stay invalid, not become an address. */
function normalize(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[(.+)]$/, "$1")
    .replace(/^::ffff:/, "");
}

/** A bindable host: an IP literal (v4/v6, brackets optional) or "localhost". No other DNS name — a
 *  bind address must be an address of THIS machine, and resolving one is not this module's job. */
export function isBindAddress(host: string): boolean {
  const h = normalize(host);
  return h === "localhost" || isIP(h) !== 0;
}

/**
 * The ADDRESS form of an accepted bind value: `localhost` becomes `127.0.0.1`, everything else is
 * already an address. Applied where a value ENTERS (the flag, `http.host`), so nothing downstream ever
 * holds a name — not deferring the resolution but removing it, which is the module's whole point.
 *
 * Two things go wrong otherwise, and both are silent. `server.listen` hands the name to `dns.lookup`,
 * which picks ONE of 127.0.0.1/::1 by rules we do not control — so what got bound is unknown here. And
 * `clientHost` would then write that NAME into control.json and the copyable curl, where a consumer
 * resolves it again, possibly to the other one.
 */
export function bindAddress(host: string): string {
  return normalize(host) === "localhost" ? "127.0.0.1" : host;
}

/**
 * How far a bind address reaches: `wildcard` (unset or all-interfaces) reaches every interface and
 * answers on loopback too; `loopback` is this machine only; `specific` is one interface, reachable
 * only as itself. Loopback covers the whole reserved range (127/8, ::1) — a `127.0.0.2` bind is no
 * more LAN-reachable than `127.0.0.1`.
 */
export function classifyBind(host: string | undefined): "wildcard" | "loopback" | "specific" {
  if (host === undefined) return "wildcard";
  const h = normalize(host);
  if (h === "0.0.0.0" || h === "::" || h === "::0") return "wildcard";
  if (h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h)) return "loopback";
  return "specific";
}

/**
 * Does a serve bound to `host` answer a dial of the NAME `localhost`? Only the addresses that name
 * resolves to (127.0.0.1 / ::1) and a wildcard bind do — `127.0.0.2` is loopback yet unreachable that
 * way. cloudflared dials by name, so `--tunnel` needs this question, not `classifyBind`'s reach.
 */
export function answersLocalhost(host: string | undefined): boolean {
  if (classifyBind(host) === "wildcard") return true;
  const h = normalize(host as string);
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** How to NAME a bind in a message: the wildcard is every interface, so calling it one address would
 *  understate it; anything else is dialable as itself. THE renderer — the ready lines, the
 *  already-in-use refusal and the generic bind failure all read a bind through this one, so a reader
 *  never sees the same bind described two ways. */
export function bindLabel(host: string | undefined, port: number): string {
  return classifyBind(host) === "wildcard" ? `port ${port}` : `${clientHost(host)}:${port}`;
}

/** The address a local client should dial for a serve bound to `host` (control.json, the ready log). */
export function clientHost(host: string | undefined): string {
  if (classifyBind(host) === "wildcard") return "127.0.0.1";
  // biome-ignore lint/style/noNonNullAssertion: only a wildcard bind leaves host undefined
  return host!.includes(":") && !host!.startsWith("[") ? `[${host}]` : host!;
}
