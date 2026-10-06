/**
 * The `fastagent dev` process supervisor: re-spawn the CLI as a worker (`FASTAGENT_DEV_WORKER=1`) and restart it on
 * debounced edits to the agent's CODE inputs.
 */
import { spawn } from "node:child_process";
import { relative, sep } from "node:path";
import { watch as watchTree } from "chokidar";
import {
  AGENT_CONFIG_FILE,
  AGENT_MODEL_CATALOG_FILE,
  AGENT_MODELS_FILE,
  resolveStateRoot,
  isUnderDir,
} from "./paths.ts";
import { dotEnvPath } from "./env.ts";
import { log } from "./log.ts";
import { openExternalUrl } from "./open-url.ts";
import { declaredChannels } from "./channels/discover.ts";
import { activeWork } from "./channels/busy.ts";
import { type Tunnel, announceWebhooks, startCloudflareTunnel } from "./tunnel.ts";

/** The agent-dir directories loaded ONCE per worker: a restart is their only re-read. (`extensions/` is reloaded by the
 *  next session after an edit.) */
const CODE_INPUT_DIRS = ["tools", "channels", "schedules"] as const;

const WATCHED_HINT = `${CODE_INPUT_DIRS.map((dir) => `${dir}/`).join(", ")}, package.json, fastagent.config.ts, models.json, models-store.json, .secrets/.env`;

/** chokidar `ignored` matcher for the narrow watch scope (true = ignore), rooted at the AGENT DIR. */
export function devWatchIgnored(root: string, envFile: string): (path: string) => boolean {
  // The `.env` is allow-listed by its RESOLVED path, not by the `.secrets` name.
  const envRel = relative(root, envFile).split(sep);
  return (path: string): boolean => {
    if (path === root) return false; // the root itself must not be pruned
    const rel = relative(root, path);
    // Code inputs at the agent dir root: config, package.json, and the dirs loaded once per worker (a restart is
    // their only re-read).
    if (rel === AGENT_CONFIG_FILE) return false;
    if (rel === "package.json") return false;
    // models.json is read ONCE per worker (agentModels' snapshot, which every session's runtime is built from), so an
    // edit needs a restart like any other code input.
    if (rel === AGENT_MODELS_FILE) return false;
    // So is the model catalog: a `models --refresh` during `dev` restarts the worker onto the new models.
    if (rel === AGENT_MODEL_CATALOG_FILE) return false;
    const segments = rel.split(sep);
    if (CODE_INPUT_DIRS.includes(segments[0] as (typeof CODE_INPUT_DIRS)[number])) return false;
    // The `.env` restarts too (credentials are process-bound).
    if (segments.length <= envRel.length && segments.every((seg, i) => seg === envRel[i])) return false;
    return true;
  };
}

/** How long a dev worker waits for its running turns before it restarts anyway. */
const DEV_RESTART_WAIT_MS = 10 * 60_000;

/**
 * In the dev worker: on the supervisor's `restart`, wait until no turn runs (`activeWork`, which every leased session
 * counts), then `stop`. Bounded by `limitMs`, after which it stops anyway and says it cut work off: a chat that
 * keeps the worker busy must not hold an edit back forever. A second `restart` while waiting is the same restart.
 */
export function listenForRestart(
  stop: () => void,
  options: { busy?: () => number; limitMs?: number; pollMs?: number } = {},
): (message: unknown) => void {
  const { busy = activeWork, limitMs = DEV_RESTART_WAIT_MS, pollMs = 100 } = options;
  let restarting = false;
  return (message) => {
    if ((message as { type?: unknown } | null)?.type !== "restart" || restarting) return;
    restarting = true;
    void (async () => {
      // `busy` counts pieces of work (a channel turn is counted queued and again leased), not turns, so no number.
      if (busy() > 0) log.info("[fastagent] restarting once the turns running now finish");
      const deadline = Date.now() + limitMs;
      while (busy() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (busy() > 0) {
        log.warn(`[fastagent] restarting with work still running after ${limitMs / 60_000} minutes: it is cut off`);
      }
      stop();
    })();
  };
}

/** Spawn the dev worker and restart it on agent-dir edits; supervise its lifecycle until the process exits. */
export async function runDevSupervisor(agentDir: string, options: { tunnel?: boolean } = {}): Promise<void> {
  // The agent directory arrives RESOLVED from the command (which already routed its refusal through failStartup).
  let worker: ReturnType<typeof spawn> | undefined;
  let reloadPending = false;
  let everServed = false; // has any worker successfully bound (sent `ready`) yet?
  let timer: NodeJS.Timeout | undefined;
  // The supervisor owns the tunnel so the public URL survives worker reloads (a fresh tunnel per save would mean a
  // new URL + re-registering the webhook on every edit).
  let tunnel: Tunnel | undefined;

  const spawnWorker = (): void => {
    // ipc fd so the worker can signal readiness once it binds; stdio otherwise inherited.
    // biome-ignore lint/style/noNonNullAssertion: argv[1] is always the script path under a node entry
    const w = spawn(process.execPath, [process.argv[1]!, ...process.argv.slice(2)], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, FASTAGENT_DEV_WORKER: "1" },
    });
    worker = w;
    w.on("message", (m: { type?: string; port?: number; routeChannels?: string[] }) => {
      if (m?.type !== "ready") return;
      everServed = true;
      // Start the tunnel once, on the first worker that binds; reuse it across reloads.
      if (options.tunnel && !tunnel && typeof m.port === "number") {
        void startCloudflareTunnel(m.port).then((t) => {
          if (t) {
            tunnel = t;
            void announceWebhooks(agentDir, t.url, declaredChannels(m.routeChannels ?? []), {
              openUrl: openExternalUrl,
              stateRoot: resolveStateRoot(agentDir),
            });
          }
        });
      }
    });
    w.on("exit", (code, signal) => {
      if (worker !== w) return; // already superseded
      worker = undefined;
      if (reloadPending) {
        reloadPending = false;
        spawnWorker(); // restart requested: the old worker has exited, so the port is free
      } else if (!everServed) {
        // Failed BEFORE ever serving — a non-editable startup failure (bad flag, EADDRINUSE, broken initial
        // definition) that saving cannot fix.
        process.exit(code ?? 1);
      } else {
        // A worker that HAD been serving stopped (broken edit or crash). Fixable; wait for the next save.
        log.warn(`[fastagent] dev stopped (worker exited: ${signal ?? code}) — save a change to retry`);
      }
    });
  };

  const triggerReload = (): void => {
    log.info(`[fastagent] change detected — restarting…`);
    if (worker) {
      reloadPending = true;
      // The worker stops once its running turns finish (listenForRestart); the exit handler respawns it then. A turn
      // that wrote the very file that changed is not cut off by its own edit. A worker whose channel is already
      // closed is exiting: its exit handler respawns it, and `send` would throw ERR_IPC_CHANNEL_CLOSED.
      if (worker.connected) worker.send({ type: "restart" });
    } else {
      spawnWorker(); // worker was down (broken edit) — retry now
    }
  };

  // chokidar gives reliable cross-platform recursion + structural ignore that native fs.watch cannot.
  const watcher = watchTree(agentDir, {
    ignoreInitial: true, // the startup scan is not a change
    ignored: devWatchIgnored(agentDir, dotEnvPath(agentDir)),
  });
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(triggerReload, 200);
  });
  watcher.on("error", (error) =>
    log.warn(`[fastagent] file watching error (${(error as Error).message}); some edits may need a manual restart`),
  );
  log.info(
    `[fastagent] watching ${WATCHED_HINT} — code edits restart the dev worker (--no-watch to disable); SYSTEM.md/APPEND_SYSTEM.md/AGENTS.md/skills/prompts go live next turn without a restart`,
  );
  // FASTAGENT_SECRETS_DIR can move the `.env` OUT of the agent dir entirely.
  if (!isUnderDir(dotEnvPath(agentDir), agentDir)) {
    log.warn(
      `[fastagent] .env lives outside the agent dir (FASTAGENT_SECRETS_DIR → ${dotEnvPath(agentDir)}) — it is NOT watched; restart dev after editing it`,
    );
  }

  const shutdown = (): never => {
    worker?.kill("SIGTERM");
    tunnel?.close();
    void watcher.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  spawnWorker();
}
