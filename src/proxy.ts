import { EnvHttpProxyAgent, install as installUndiciFetch, setGlobalDispatcher } from "undici";

/**
 * Route fetch through HTTPS_PROXY and keep fetch + dispatcher on the SAME undici implementation. Any
 * process that hits a provider or a channel API needs this: Node's fetch does not honor HTTPS_PROXY by
 * itself (so login's OAuth token exchange, model calls, and a webhook setWebhook would go direct,
 * bypassing a region proxy), and Node 26's bundled fetch skips gzip decompression without install()
 * (empty stopReason:"stop"). A process-global side effect — call it once at a command/entry start.
 */
export function installProxyFetch(): void {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  installUndiciFetch();
}
