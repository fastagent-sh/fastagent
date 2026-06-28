/**
 * `--tunnel`: expose the local dev server on a public HTTPS URL via a Cloudflare quick tunnel, then
 * auto-register the first-party webhook channels against it (telegram setWebhook; github prints the
 * URL to paste into repo settings). This closes the "local dev → public URL" gap webhooks need.
 *
 * Process orchestration, not assembly — lives outside the engine, beside dev-supervisor.ts.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface Tunnel {
  url: string;
  close(): void;
}

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Extract a Cloudflare quick-tunnel URL from a chunk of cloudflared output, if present. */
export function parseTunnelUrl(chunk: string): string | undefined {
  return chunk.match(TUNNEL_URL_RE)?.[0];
}

/**
 * Start a Cloudflare quick tunnel to localhost:`port`, resolving once its public URL appears. Resolves
 * to undefined (with an actionable hint) if cloudflared is not installed — serving continues either way.
 */
export function startCloudflareTunnel(port: number): Promise<Tunnel | undefined> {
  return new Promise((resolve) => {
    const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const onChunk = (buf: Buffer): void => {
      if (settled) return;
      const url = parseTunnelUrl(String(buf));
      if (url) {
        settled = true;
        resolve({ url, close: () => child.kill("SIGTERM") });
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk); // cloudflared prints the URL on stderr
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      console.error(
        e.code === "ENOENT"
          ? "[fastagent] --tunnel needs cloudflared — install it (e.g. `brew install cloudflared`), then re-run. Serving without a tunnel."
          : `[fastagent] cloudflared failed: ${e.message}. Serving without a tunnel.`,
      );
      resolve(undefined);
    });
    child.on("exit", () => {
      if (!settled) {
        settled = true;
        resolve(undefined); // exited before printing a URL
      }
    });
  });
}

/** Channel basenames present in `<dir>/channels/`. */
function channelBasenames(dir: string): string[] {
  try {
    return readdirSync(join(dir, "channels"))
      .filter((n) => /\.(ts|js|mjs)$/.test(n) && !n.endsWith(".d.ts"))
      .map((n) => n.replace(/\.(ts|js|mjs)$/, ""));
  } catch {
    return [];
  }
}

/**
 * Print the public URL and wire up the first-party webhook channels found under `dir`: telegram is
 * auto-registered via setWebhook (using .env tokens); github prints the URL to add in repo settings.
 */
export async function announceWebhooks(dir: string, baseUrl: string): Promise<void> {
  console.error(`[fastagent] public URL: ${baseUrl}`);
  try {
    process.loadEnvFile(join(dir, ".env")); // so telegram registration sees the tokens
  } catch {
    /* no .env is fine */
  }
  const channels = channelBasenames(dir);
  if (channels.includes("telegram")) await registerTelegram(baseUrl);
  if (channels.includes("github")) {
    console.error(
      `[fastagent] github: add a webhook in your repo (Settings → Webhooks): Payload URL = ${baseUrl}/webhook, content type application/json, secret = GITHUB_WEBHOOK_SECRET`,
    );
  }
}

async function registerTelegram(baseUrl: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_SECRET_TOKEN;
  const webhookUrl = `${baseUrl}/telegram`;
  if (!botToken || !secret) {
    console.error(
      `[fastagent] telegram: set TELEGRAM_BOT_TOKEN + TELEGRAM_SECRET_TOKEN in .env, then re-run to auto-register. Webhook URL: ${webhookUrl}`,
    );
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, secret_token: secret }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (res.ok && data.ok) {
      console.error(`[fastagent] telegram: webhook registered → ${webhookUrl}`);
    } else {
      console.error(
        `[fastagent] telegram: setWebhook failed (${res.status}${data.description ? `: ${data.description}` : ""}). Register manually with url=${webhookUrl}`,
      );
    }
  } catch (e) {
    console.error(`[fastagent] telegram: setWebhook error (${String(e)}). Register manually with url=${webhookUrl}`);
  }
}
