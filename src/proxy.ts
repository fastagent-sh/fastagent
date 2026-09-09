// Namespace import (not `import { install }`): Bun's `undici` is a native shim that omits `install`, and a STATIC
// NAMED import of a missing export fails at link time.
import * as undici from "undici";

/** The Bun runtime (`process.versions.bun` is set only there). */
const isBun = typeof process.versions.bun === "string";

/**
 * What is ALWAYS exempt from the proxy. `EnvHttpProxyAgent` proxies EVERYTHING while NO_PROXY is empty — loopback
 * included ("Always proxy if NO_PROXY is not set or empty") — so installing a proxy would otherwise send this process's
 * own local traffic through it: a Docker health probe on 127.0.0.1, a control-plane call to a local serve, an `ssh -L`
 * forward given to `attach --url`. None of those are what a proxy variable is asking for.
 *
 * APPENDED to a declared NO_PROXY rather than used as its default, because `NO_PROXY=.corp.com` is the normal shape of
 * a corporate environment and it is not a statement about 127.0.0.1: replacing would hand exactly the users who have a
 * proxy back the failure this exists to remove, as a probe timeout rather than an error.
 */
const LOOPBACK = "localhost,127.0.0.1,::1";

/**
 * The exemption list the dispatcher is built with: whatever the environment declares, plus {@link LOOPBACK}.
 *
 * Its own function because installing happens ONCE per process, so these branches are unreachable through
 * {@link installProxyFetch} — and the wildcard one is the kind that is silently wrong until someone reads it.
 */
export function noProxyList(env: NodeJS.ProcessEnv = process.env): string {
  // Mirroring undici's own precedence (lowercase first) so our value cannot disagree with the one it would read.
  // `||`, not `??`: a `NO_PROXY=` line in a .env is an empty string, and undici treats it as "proxy everything".
  const declared = (env.no_proxy || env.NO_PROXY)?.trim();
  if (!declared) return LOOPBACK;
  // `*` is undici's "never proxy anything", matched EXACTLY (`#noProxyValue === '*'`). Appending would demote it to a
  // hostname that matches nothing — turning "disable the proxy" into "proxy everything but loopback".
  return declared === "*" ? declared : `${declared},${LOOPBACK}`;
}

/** The install is process-global and once is enough; a second call would only leak the first dispatcher (nothing
 *  closes it) and re-read the same environment. */
let installed = false;

/** Whoever owned `fetch` before this module loaded. A caller that replaced it since (a test's mock, an embedder's
 *  instrumentation) meant it, so the swap below leaves it alone — the dispatcher still routes everything that runs
 *  on undici's global. */
const originalFetch = globalThis.fetch;

/**
 * Point this process's fetch at the proxy the environment declares, with loopback exempt by default.
 *
 * Two jobs in one, and both are needed UNDER NODE: Node's fetch does not honor HTTP(S)_PROXY at all, and Node 26's
 * bundled fetch skips gzip decompression when it dispatches through npm undici (empty `stopReason:"stop"`), so fetch
 * and the dispatcher must come from the SAME undici. No-op under Bun, whose native fetch already does both (and
 * lacks these entry points).
 *
 * Call it through `enterAgentEnv` (env.ts) rather than directly: the proxy may be declared in the agent's own `.env`,
 * so it has to be read first. The only direct callers are the ones with no agent directory to read.
 */
export function installProxyFetch(): void {
  if (isBun || installed) return;
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ noProxy: noProxyList() }));
  // Skipping `install` leaves the caller's fetch in place, and with it Node 26's missing gzip decompression above.
  if (globalThis.fetch === originalFetch) undici.install();
  installed = true; // last: a throw above must leave the latch open, or the process runs un-proxied forever
}
