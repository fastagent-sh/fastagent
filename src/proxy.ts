// Namespace import (not `import { install }`): Bun's `undici` is a native shim that omits `install`, and a STATIC
// NAMED import of a missing export fails at link time.
import * as undici from "undici";

/** The Bun runtime (`process.versions.bun` is set only there). */
const isBun = typeof process.versions.bun === "string";

/** Route fetch through HTTPS_PROXY and keep fetch + dispatcher on the SAME undici implementation. */
export function installProxyFetch(): void {
  if (isBun) return;
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
  undici.install();
}
