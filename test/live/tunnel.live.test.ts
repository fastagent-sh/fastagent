/**
 * A Cloudflare Quick Tunnel, end to end: `--tunnel` is only worth anything if the URL it prints is
 * reachable from the public internet and routes back to this process. The offline test
 * (test/tunnel.test.ts) covers the parsing — which line of cloudflared's output is the URL, and which
 * error line must NOT be mistaken for one — against a fake process. What it cannot cover is whether
 * cloudflared still starts, still prints a URL in a shape the parser knows, and whether that URL
 * actually carries a request home.
 *
 * Drives `startCloudflareTunnel`, the same function `dev --tunnel` and `deploy docker --tunnel` use.
 * Needs the `cloudflared` binary on PATH and no credentials: a Quick Tunnel is anonymous.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { waitForHealth } from "../../src/channels/wait-health.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { startCloudflareTunnel } from "../../src/tunnel.ts";

// Node's fetch ignores HTTPS_PROXY; reaching the tunnel's public URL from a proxied machine needs the
// same call every CLI entry makes. See model.live.test.ts for why the library opener does not make it.
installProxyFetch();

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

describe("cloudflare quick tunnel", () => {
  it("assigns a public URL that carries a request back to this process", async () => {
    // Checked first, and separately: startCloudflareTunnel reports a missing binary and a tunnel that
    // failed to establish as the same `undefined`, and the two need opposite actions from whoever ran
    // this. Same rule as env.ts — a missing precondition is named, not diagnosed from a symptom.
    expect(
      spawnSync("cloudflared", ["--version"]).error,
      "live probes need cloudflared on PATH (e.g. `brew install cloudflared`)",
    ).toBeUndefined();

    // A body only this run knows: proof the response came from OUR origin and not from a cached page,
    // a captive portal, or another tunnel.
    const token = randomUUID();
    const origin = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(token);
    });
    // No host, so Node binds every interface: cloudflared is pointed at `http://localhost:<port>`
    // (src/tunnel.ts) and this probe is about the tunnel, not about which address that name resolves
    // to inside it. Whether a 127.0.0.1-only origin answers is the product's own question, settled by
    // `answersLocalhost` (src/bind.ts) and exercised by telegram.live.test.ts, which binds one.
    await new Promise<void>((resolve) => origin.listen(0, resolve));
    cleanups.push(() => origin.close());
    const { port } = origin.address() as { port: number };

    const tunnel = await startCloudflareTunnel(port);
    // `undefined` is how the product reports "no tunnel" — every caller treats it as a hard stop, so
    // a probe that let it through would be asserting nothing at all.
    expect(tunnel, "cloudflared did not yield a quick-tunnel URL").toBeDefined();
    if (!tunnel) return;
    cleanups.push(() => tunnel.close());
    expect(tunnel.url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i);

    // A fresh hostname's DNS takes seconds to become resolvable — the same wait the webhook
    // registrars do before handing a platform a URL to verify.
    expect(await waitForHealth(tunnel.url, 60_000, 1000), `${tunnel.url} never became reachable`).toBe(true);
    expect(await fetch(tunnel.url).then((r) => r.text())).toBe(token);
  });
});
