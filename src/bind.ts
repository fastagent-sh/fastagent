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

/** A bindable host: an IP literal (v4/v6, brackets optional) or "localhost". No DNS names — a bind
 *  address must be an address of THIS machine, and resolving one at parse time is not our job. */
export function isBindAddress(host: string): boolean {
  const h = normalize(host);
  return h === "localhost" || isIP(h) !== 0;
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

/** The address a local client should dial for a serve bound to `host` (control.json, the ready log). */
export function clientHost(host: string | undefined): string {
  if (classifyBind(host) === "wildcard") return "127.0.0.1";
  // biome-ignore lint/style/noNonNullAssertion: only a wildcard bind leaves host undefined
  return host!.includes(":") && !host!.startsWith("[") ? `[${host}]` : host!;
}
