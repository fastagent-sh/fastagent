/**
 * `--tunnel`: expose the local dev server on a public HTTPS URL via a Cloudflare quick tunnel, then
 * auto-register the first-party webhook channels against it (telegram setWebhook; lark application-
 * config PATCH; github prints the URL to paste into repo settings). This closes the "local dev →
 * public URL" gap webhooks need.
 *
 * Process orchestration, not assembly — lives outside the engine, beside dev-supervisor.ts.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { registerLarkWebhook } from "./channels/lark/register-webhook.ts";
import { registerTelegramWebhook } from "./channels/telegram/register-webhook.ts";
import { loadDotEnv } from "./env.ts";
import { log } from "./log.ts";

export interface Tunnel {
  url: string;
  close(): void;
}

// `(?!api\.)`: cloudflared's ERROR lines mention its request endpoint (`https://api.trycloudflare.com/tunnel`,
// e.g. "failed to request quick Tunnel: Post ... timeout" under a flaky proxy) — without the exclusion a
// transient error line parses as the assigned URL and the webhook gets registered against Cloudflare's
// API host instead of the tunnel.
const TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

/** Extract a Cloudflare quick-tunnel URL from a chunk of cloudflared output, if present. */
export function parseTunnelUrl(chunk: string): string | undefined {
  return chunk.match(TUNNEL_URL_RE)?.[0];
}

/** Global timer (rather than timers/promises) so timeout/retry behavior is deterministic under fake timers. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TUNNEL_ATTEMPTS = 3;
const TUNNEL_RETRY_MS = 2000;
/** cloudflared can stay alive without ever receiving/printing an assigned quick-tunnel URL. */
const TUNNEL_START_TIMEOUT_MS = 30_000;

/** How cloudflared is launched; injectable so tests can drive the child without a real process. */
type SpawnCloudflared = (port: number) => ChildProcess;
const spawnCloudflared: SpawnCloudflared = (port) =>
  spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });

type TunnelSpawn =
  | { tunnel: Tunnel }
  | { tunnel?: undefined; fatal: true; message: string }
  | { tunnel?: undefined; fatal: false; detail?: string };

/**
 * Start a Cloudflare quick tunnel to localhost:`port`, resolving once its public URL appears.
 * cloudflared sometimes exits before printing a URL (a transient trycloudflare API error), so retry a
 * few times. ALWAYS resolves to undefined WITH an operator log saying why — missing binary, the exit
 * reason, or "gave up after retries" — never silently; serving continues without a tunnel either way.
 * (Edge warmup AFTER the URL appears is handled downstream: the telegram registrar polls /health before
 * it calls setWebhook, so a not-yet-routable tunnel just delays registration rather than failing it.)
 */
export async function startCloudflareTunnel(
  port: number,
  spawnFn: SpawnCloudflared = spawnCloudflared,
  attemptTimeoutMs: number = TUNNEL_START_TIMEOUT_MS,
): Promise<Tunnel | undefined> {
  for (let attempt = 1; attempt <= TUNNEL_ATTEMPTS; attempt++) {
    const r = await spawnTunnelOnce(port, spawnFn, attemptTimeoutMs);
    if (r.tunnel) return r.tunnel;
    if (r.fatal) {
      log.error(r.message); // missing binary — retrying cannot help
      return undefined;
    }
    const more = attempt < TUNNEL_ATTEMPTS;
    log.warn(
      `[fastagent] --tunnel: cloudflared exited before a public URL appeared${r.detail ? ` (${r.detail})` : ""}` +
        (more ? ` — retrying (${attempt}/${TUNNEL_ATTEMPTS - 1})…` : ". Serving without a tunnel."),
    );
    if (more) await sleep(TUNNEL_RETRY_MS);
  }
  return undefined;
}

/** One cloudflared launch: a Tunnel on the first URL, or a failure (missing binary / exit before a URL). */
function spawnTunnelOnce(port: number, spawnFn: SpawnCloudflared, timeoutMs: number): Promise<TunnelSpawn> {
  return new Promise((resolve) => {
    const child = spawnFn(port);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let tail = ""; // recent output, surfaced as the failure reason
    const finish = (result: TunnelSpawn): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const onChunk = (buf: Buffer): void => {
      tail = (tail + String(buf)).slice(-600);
      const url = parseTunnelUrl(String(buf));
      if (url) finish({ tunnel: { url, close: () => child.kill("SIGTERM") } });
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk); // cloudflared prints the URL (and its errors) on stderr
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        finish({
          fatal: true,
          message:
            "[fastagent] --tunnel needs cloudflared — install it (e.g. `brew install cloudflared`), then re-run. Serving without a tunnel.",
        });
      } else {
        finish({ fatal: false, detail: e.message });
      }
    });
    child.on("exit", () => finish({ fatal: false, detail: lastErrorLine(tail) }));
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ fatal: false, detail: `timed out after ${Math.round(timeoutMs / 1000)}s waiting for a public URL` });
    }, timeoutMs);
    timer.unref();
  });
}

/** The most informative line of cloudflared's output tail (prefer an error line) for a failure log. */
function lastErrorLine(tail: string): string {
  const lines = tail
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return ([...lines].reverse().find((l) => /err|error|failed/i.test(l)) ?? lines.at(-1) ?? "").slice(0, 200);
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
  log.info(`[fastagent] public URL: ${baseUrl}`);
  try {
    loadDotEnv(dir); // telegram registration reads tokens from .env
  } catch (error) {
    // best-effort boundary: a MISSING .env is already tolerated by loadDotEnv; an unreadable one (EACCES,
    // or .env is a directory) must NOT crash the long-running dev/start server — announceWebhooks is
    // void-called with no unhandledRejection handler, so a throw here would terminate the process. Warn
    // (surface it, rule 8) and continue best-effort; telegram registration then degrades to its manual
    // instruction if the token is absent. loadDotEnv keeps throwing for the synchronous command callers.
    log.warn(`[fastagent] could not read ${join(dir, ".env")}: ${(error as Error).message} — continuing without it`);
  }
  const channels = channelBasenames(dir);
  if (channels.length === 0) return;
  // Readiness is the registrar's job now: a fresh quick tunnel returns Cloudflare 530 for ~20-30s before
  // its origin connects, and registerTelegramWebhook polls /health until it serves before setWebhook (the
  // same wait the deploy runners rely on). github needs no wait — the operator adds that webhook by hand.
  if (channels.includes("telegram")) await registerTelegramWebhook(baseUrl);
  if (channels.includes("github")) {
    log.info(
      `[fastagent] github: add a webhook in your repo (Settings → Webhooks): Payload URL = ${baseUrl}/webhook, content type application/json, secret = GITHUB_WEBHOOK_SECRET`,
    );
  }
  // feishu/lark register programmatically too (application-v7 config PATCH — telegram-setWebhook
  // parity), once per mounted kind (each kind is its own app with its own credentials); the registrar
  // owns its own health wait and degrades to the manual console instruction.
  if (channels.includes("feishu")) await registerLarkWebhook(baseUrl, "feishu");
  if (channels.includes("lark")) await registerLarkWebhook(baseUrl, "lark");
}
