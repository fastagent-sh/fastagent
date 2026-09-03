/**
 * `--tunnel`: expose the local dev server on a public HTTPS URL via a Cloudflare quick tunnel, then
 * auto-register the first-party webhook channels against it (Telegram setWebhook; onboarded Slack
 * App Manifest update; Feishu/Lark application-config PATCH; GitHub/manual Slack print URLs). This closes the
 * "local dev → public URL" gap webhooks need.
 *
 * Process orchestration, not assembly — lives outside the engine, beside dev-supervisor.ts.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { RegistrationOutcome } from "./channels/registration.ts";
import type { DeclaredChannel } from "./channels/discover.ts";
import { registerFeishuWebhook } from "./channels/feishu/register-webhook.ts";
import { registerSlackWebhook } from "./channels/slack/register-webhook.ts";
import { registerTelegramWebhook } from "./channels/telegram/register-webhook.ts";
import { pointChannelsAt } from "./deploy/channel-ingress.ts";
import { dotEnvPath, loadDotEnv } from "./env.ts";
import { resolveStateRoot } from "./paths.ts";
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

/**
 * cloudflared's line for an established edge connection. THIS, not the URL, is when the hostname
 * begins to exist: `*.trycloudflare.com` is no wildcard, and a quick tunnel's record is published
 * once the tunnel registers a connection — so the URL is printed while the name is still NXDOMAIN.
 * A platform told about it inside that window answers "Failed to resolve host" and goes on answering
 * it far longer than any registrar's retry budget (#435); the record going live seconds later does
 * not undo the answer it already gave, which is why more retries were never the fix.
 *
 * Measured over 7 quick tunnels: the URL at +0s, this line at +1.1-1.9s, the record 0.5-3.9s later.
 */
const TUNNEL_CONNECTED_RE = /Registered tunnel connection/i;

/** Whether cloudflared's output so far reports an edge connection — see {@link TUNNEL_CONNECTED_RE}. */
export function hasTunnelConnection(output: string): boolean {
  return TUNNEL_CONNECTED_RE.test(output);
}

/**
 * How long after that connection to hand the URL over. The one number here that is not observed: 5s
 * covers the widest of the 7 measured gaps (3.9s), all taken over cloudflared's http2 transport
 * because this network blocks its QUIC. Costs a beat of `dev --tunnel` start-up; buys the first
 * registration attempt landing on a name that resolves.
 */
export const TUNNEL_DNS_LAG_MS = 5000;

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
 * Start a Cloudflare quick tunnel to localhost:`port`, resolving once its public URL is assigned AND
 * the tunnel has an edge connection — the URL is printed first and is not usable yet
 * ({@link hasTunnelConnection}). cloudflared sometimes exits before printing a URL (a transient
 * trycloudflare API error), so retry a few times. ALWAYS resolves to undefined WITH an operator log
 * saying why — missing binary, the exit reason, or "gave up after retries" — never silently; serving
 * continues without a tunnel either way. What remains after this is the PLATFORM's own warm-up, which
 * each registrar absorbs by retrying while the platform reports it cannot yet verify the URL.
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

/** One cloudflared launch: a Tunnel once its URL is assigned AND the edge connection is up, or a
 *  failure (missing binary / exit before a URL). */
function spawnTunnelOnce(port: number, spawnFn: SpawnCloudflared, timeoutMs: number): Promise<TunnelSpawn> {
  return new Promise((resolve) => {
    const child = spawnFn(port);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let handOver: NodeJS.Timeout | undefined;
    let tail = ""; // recent output, surfaced as the failure reason
    let assigned: string | undefined; // printed well before the tunnel can carry anything
    const finish = (result: TunnelSpawn): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (handOver) clearTimeout(handOver);
      resolve(result);
    };
    const handOverNow = (url: string): void => finish({ tunnel: { url, close: () => child.kill("SIGTERM") } });
    const onChunk = (buf: Buffer): void => {
      tail = (tail + String(buf)).slice(-600);
      assigned ??= parseTunnelUrl(String(buf));
      if (!assigned || handOver || !hasTunnelConnection(tail)) return;
      const url = assigned;
      handOver = setTimeout(() => handOverNow(url), TUNNEL_DNS_LAG_MS);
      handOver.unref();
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
      // A URL whose tunnel never connected is not worth a fresh one — the next attempt meets the same
      // network. Serve it and name what is wrong, rather than retrying into the same wall.
      if (assigned) {
        log.warn(
          `[fastagent] --tunnel: cloudflared never reported an edge connection for ${assigned} within ` +
            `${Math.round(timeoutMs / 1000)}s — serving it anyway. Nothing reaches a tunnel that has not ` +
            "connected, so a webhook registration that cannot resolve the host is this, not the platform.",
        );
        handOverNow(assigned);
        return;
      }
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

/**
 * Print the public URL and wire up first-party webhook channels found under `dir` (the agent
 * ROOT): Telegram and Feishu/Lark use runtime credentials; onboarded Slack uses its owner-local config
 * token; GitHub and a manually scaffolded Slack app receive explicit console URLs.
 *
 * Returns what each registrar ANSWERED, because two kinds of caller need different things from a
 * failure. `dev`/`start` are long-running: a webhook that did not register is a logged problem, not
 * a reason to stop serving, and they void this. `deploy … --run` is a command that exits, and an
 * exit 0 there tells its caller the deployment is reachable — so it feeds these through
 * `registrationGate`, exactly as the fly/railway/agentcore runners feed their own registrar calls
 * (docker used to be the one host that could not, because this returned nothing).
 */
export async function announceWebhooks(
  dir: string,
  baseUrl: string,
  /** Every declared channel with its ingress. Not a pre-filtered list: this used to accept "the route
   *  channels" and default to every basename in `channels/`, which pointed a webhook at a
   *  long-connection channel whenever a caller forgot to filter. {@link pointChannelsAt} filters. */
  channels: readonly DeclaredChannel[],
  opts: { openUrl?: (url: string) => void; stateRoot?: string } = {},
): Promise<{ kind: string; outcome: RegistrationOutcome }[]> {
  log.info(`[fastagent] public URL: ${baseUrl}`);
  try {
    loadDotEnv(dir); // webhook registrars read channel credentials from .env
  } catch (error) {
    // best-effort boundary: a MISSING .env is already tolerated by loadDotEnv; an unreadable one (EACCES,
    // or .env is a directory) must NOT crash the long-running dev/start server — announceWebhooks is
    // void-called with no unhandledRejection handler, so a throw here would terminate the process. Warn
    // (surface it, rule 8) and continue best-effort; each registrar then surfaces its own
    // missing-credential guidance. loadDotEnv keeps throwing for the synchronous command callers.
    log.warn(`[fastagent] could not read ${dotEnvPath(dir)}: ${(error as Error).message} — continuing without it`);
  }
  // Readiness is the registrar's job: a fresh quick tunnel returns Cloudflare 530 for ~20-30s before its
  // origin connects, and each registrar absorbs that by retrying the platform call whose own URL
  // verification reports it. GitHub needs no wait — the operator adds that webhook by hand.
  //
  // The registrars differ from the deploy path's in what they carry, not in which channels they answer
  // for: this one narrates to the log and opens the console for a manual Feishu step.
  const feishuOptions = {
    onManualRegistration: ({ consoleUrl }: { consoleUrl: string }) => opts.openUrl?.(consoleUrl),
  };
  return pointChannelsAt({
    baseUrl,
    channels,
    log: (message) => log.info(`[fastagent] ${message}`),
    registrars: {
      telegram: (url) => registerTelegramWebhook(url),
      slack: (url) =>
        registerSlackWebhook(url, {
          stateRoot: opts.stateRoot ?? resolveStateRoot(dir),
          log: (message) => log.info(message),
        }),
      feishu: (url, kind) => registerFeishuWebhook(url, kind, feishuOptions),
    },
  });
}
