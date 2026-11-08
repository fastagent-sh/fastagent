/**
 * What proves a platform reaches this instance at a URL only a person sets (Slack's Request URL; Lark's where its
 * configuration API is missing): an authenticated request from it, and the address it was sent to (SPEC.md §8,
 * channel-setup.md §5). A platform's signature or token proves who sent a request, not where, so the address is read
 * from the request's host and forwarding headers. The first-party channel records it, durable in its own state
 * directory, and a serve in this process hears it at once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { log } from "../log.ts";

const EVIDENCE_FILE = "reached.json";

/** Where the request was sent: its scheme, host and path, as the proxy in front of the server says it received them. */
function requestAddress(request: Request): string {
  const url = new URL(request.url);
  const first = (value: string | null) => value?.split(",")[0]?.trim() || undefined;
  const scheme = first(request.headers.get("x-forwarded-proto")) ?? url.protocol.replace(/:$/, "");
  const host = first(request.headers.get("x-forwarded-host")) ?? request.headers.get("host") ?? url.host;
  return `${scheme}://${host}${url.pathname}`;
}

/**
 * Whether `address` is `<publicUrl><path>`: the scheme, the host and the channel's own path. A mount prefix is
 * `publicUrl`'s, since an embedding app's router may strip it before the channel sees the request.
 */
export function addressedTo(address: string, publicUrl: string, path: string): boolean {
  const reached = new URL(address);
  const expected = new URL(publicUrl);
  return reached.protocol === expected.protocol && reached.host === expected.host && reached.pathname.endsWith(path);
}

const listeners = new Map<string, Set<(address: string) => void>>();
const recorded = new Map<string, string>();

/** Record that an authenticated request from the platform reached the channel whose state is `stateDir`. */
export function recordReached(stateDir: string, request: Request): void {
  const address = requestAddress(request);
  if (recorded.get(stateDir) === address) return;
  recorded.set(stateDir, address);
  try {
    writeFileAtomic(join(stateDir, EVIDENCE_FILE), `${JSON.stringify({ address, at: new Date().toISOString() })}\n`);
  } catch (error) {
    // The request is answered either way; a record not kept costs a `manual` after the next restart, said here.
    log.warn(`[fastagent] could not record that ${address} was reached: ${String(error)}`);
  }
  for (const listener of listeners.get(stateDir) ?? []) listener(address);
}

/** The address an authenticated request last reached the channel at, as recorded, if any. */
export function readReached(stateDir: string): string | undefined {
  try {
    const { address } = JSON.parse(readFileSync(join(stateDir, EVIDENCE_FILE), "utf8")) as { address?: unknown };
    return typeof address === "string" ? address : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    log.warn(`[fastagent] could not read ${join(stateDir, EVIDENCE_FILE)}: ${String(error)}`);
    return undefined;
  }
}

/** Hear each address recorded for `stateDir` from now on; the answer stops it. */
export function onReached(stateDir: string, listener: (address: string) => void): () => void {
  const set = listeners.get(stateDir) ?? new Set();
  set.add(listener);
  listeners.set(stateDir, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(stateDir);
  };
}
