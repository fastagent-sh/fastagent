/**
 * Feishu verifies an event Request URL by CALLING it: the `PATCH` that sets the URL makes the platform
 * POST a `url_verification` challenge, and the URL is only stored if our handler echoes the challenge
 * back. That is a real inbound round trip — platform → our route → platform — which is one step past
 * what the telegram probe can reach (Telegram only checks that the URL answers).
 *
 * The chain is all product entries: `createAgentService` mounts `channels/feishu.ts` at `POST /feishu`
 * → `serveNode` binds it → `startCloudflareTunnel` publishes it → `registerFeishuWebhook` PATCHes the
 * subscription, retrying while the platform reports it could not verify the URL, and reports what it
 * answered. A `registered` outcome IS the platform's verdict on that round trip.
 *
 * Needs `FEISHU_APP_ID` + `FEISHU_APP_SECRET` for an app of its own — this probe REWRITES that app's
 * event Request URL, so pointing it at an app serving real traffic would take that traffic down.
 * `fastagent add feishu` creates one in a scan-to-confirm flow.
 *
 * It does NOT restore the subscription afterwards, unlike the telegram probe's `deleteWebhook`. The
 * app is left pointing at a closed `*.trycloudflare.com` until the next run rewrites it, which is
 * inert for an app of the probe's own and is the state a failed run would leave anyway. Restoring
 * would mean flipping the app back to `websocket` — a second mode change per run, on the very
 * migration path this probe exists to verify — for no observable gain.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { serveNode } from "../../src/channels/serve.ts";
import { registerFeishuWebhook } from "../../src/channels/feishu/register-webhook.ts";
import { createAgentService } from "../../src/engines/pi/service.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { startCloudflareTunnel } from "../../src/tunnel.ts";
import { requireEnv } from "./env.ts";

// Node's fetch ignores HTTPS_PROXY; the registrar's PATCH and the readiness poll both need this.
installProxyFetch();

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
requireEnv("FEISHU_APP_ID", "an app of this probe's OWN, from `fastagent add feishu`");
requireEnv("FEISHU_APP_SECRET", "the app secret that came with FEISHU_APP_ID");
requireEnv("FEISHU_VERIFICATION_TOKEN", "console → Events & Callbacks; `add feishu --ingress webhook` captures it");

// Every cleanup runs, in reverse, and failures surface together — a loop that stops at the first
// failure would leave a public *.trycloudflare.com URL pointed at this service.
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "cleanup failed");
});

describe("feishu: registering an event URL the platform verifies by calling it", () => {
  it("the platform's challenge reaches our route and the subscription is stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-live-feishu-"));
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: ${JSON.stringify(MODEL)} };\n`);
    await mkdir(join(dir, "channels"), { recursive: true });
    // The scaffold's own import is the package name, which resolves through the agent dir's
    // node_modules; a throwaway directory has none. Importing this checkout by path loads the same
    // `feishuChannel` the scaffold would, which is what mounts POST /feishu — the route the platform
    // is about to call.
    const feishuModule = fileURLToPath(new URL("../../src/feishu.ts", import.meta.url));
    await writeFile(
      join(dir, "channels", "feishu.ts"),
      `import { feishuChannel } from ${JSON.stringify(feishuModule)};\n` +
        `export default feishuChannel({\n` +
        `  appId: process.env.FEISHU_APP_ID ?? "",\n` +
        `  appSecret: process.env.FEISHU_APP_SECRET ?? "",\n` +
        `  verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? "",\n` +
        // The scaffold carries this and the console flow marks it RECOMMENDED, so a probe app created
        // that way HAS an Encrypt Key. Omitting it here would make the platform's url_verification
        // arrive encrypted at a handler that refuses it (401), surfacing as a bare `registered`
        // assertion failure with the real reason buried in the channel's own log.
        `  encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined,\n` +
        `});\n`,
    );

    const service = await createAgentService(dir);
    // `service.routes` is the literal route table; `channels.routes` next to it is the channel FILE
    // names. The platform is about to call this path, so assert the path.
    expect(Object.keys(service.routes), "channels/feishu.ts did not mount POST /feishu").toContain("POST /feishu");

    const server = serveNode(service.handler, { port: 0, host: "127.0.0.1" });
    cleanups.push(() => server.close());
    const port = await server.listening;

    const tunnel = await startCloudflareTunnel(port);
    expect(tunnel, "cloudflared did not yield a quick-tunnel URL").toBeDefined();
    if (!tunnel) return;
    cleanups.push(() => tunnel.close());

    // The PATCH triggers the platform's url_verification challenge against `${tunnel.url}/feishu`.
    // "registered" means the platform called us, our handler echoed the challenge, and it stored the
    // URL — the round trip, not our own opinion of it.
    const outcome = await registerFeishuWebhook(tunnel.url, "feishu");
    expect(outcome, "feishu did not store the event URL (see the registrar's log line for its reason)").toBe(
      "registered",
    );
  });
});
