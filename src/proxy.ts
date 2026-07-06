// Namespace import (not `import { install }`): Bun's `undici` is a native shim that omits `install`, and
// a STATIC NAMED import of a missing export fails at link time — crashing `fastagent start` under Bun
// before any code runs. A namespace import binds whatever exports exist; the Bun guard below then never
// touches the Node-only members.
import * as undici from "undici";

/** The Bun runtime (`process.versions.bun` is set only there). Bun's native fetch already honors the
 *  proxy env vars and decompresses gzip, and its `undici` shim has no `install()` — so the Node-only
 *  undici wiring below is both unnecessary and unavailable there. */
const isBun = typeof process.versions.bun === "string";

/**
 * Route fetch through HTTPS_PROXY and keep fetch + dispatcher on the SAME undici implementation. Any
 * process that hits a provider or a channel API needs this UNDER NODE: Node's fetch does not honor
 * HTTPS_PROXY by itself (so login's OAuth token exchange, model calls, and a webhook setWebhook would go
 * direct, bypassing a region proxy), and Node 26's bundled fetch skips gzip decompression without
 * install() (empty stopReason:"stop"). A process-global side effect — call it once at a command/entry
 * start. No-op under Bun, whose native fetch already does both (and lacks the undici entry points).
 */
export function installProxyFetch(): void {
  if (isBun) return;
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
  undici.install();
}
