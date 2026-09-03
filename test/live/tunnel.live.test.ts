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
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { waitForHealth } from "../../src/channels/wait-health.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { hasTunnelConnection, startCloudflareTunnel } from "../../src/tunnel.ts";

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

    // A fresh hostname can take a minute to become resolvable FROM HERE — and on a machine whose
    // resolver or proxy is slow about it, longer than this budget (#421). That is why the webhook
    // registrars no longer ask this question at all; this probe still does, because reaching the URL
    // from outside cloudflared is the only way to prove the tunnel carries a request home.
    expect(await waitForHealth(tunnel.url, 60_000, 1000), `${tunnel.url} never became reachable`).toBe(true);
    expect(await fetch(tunnel.url).then((r) => r.text())).toBe(token);
  });

  /**
   * The one assumption behind #435 that lives in another project's source: cloudflared announces its
   * first edge connection in words {@link hasTunnelConnection} knows, and the DNS record follows THAT,
   * not the URL. Asserted here because a change to it degrades the product INVISIBLY — nothing fails,
   * every tunnel is just handed over a connect-timeout late with a warning about a tunnel that is
   * fine. Same shape as the fly/railway CLI probes: a real tool's output against this repo's reading
   * of it, which is the belief a faked child process cannot test.
   */
  it("cloudflared still announces its edge connection in the words the hand-over waits for", async () => {
    const child = spawn("cloudflared", ["tunnel", "--url", "http://localhost:9"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(() => child.kill("SIGTERM"));
    const connected = await new Promise<boolean>((resolve) => {
      let output = "";
      const timer = setTimeout(() => resolve(false), 90_000);
      const onChunk = (buf: Buffer): void => {
        output += String(buf);
        if (!hasTunnelConnection(output)) return;
        clearTimeout(timer);
        resolve(true);
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk); // cloudflared logs to stderr
    });
    expect(connected, "cloudflared printed no line hasTunnelConnection recognises").toBe(true);
  }, 120_000);
});
