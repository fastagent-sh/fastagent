/**
 * The `fastagent dev` process supervisor: re-spawn the CLI as a worker (`FASTAGENT_DEV_WORKER=1`) and restart it on
 * debounced edits to the agent's CODE inputs.
 */
import { spawn } from "node:child_process";
import { relative, sep } from "node:path";
import { watch as watchTree } from "chokidar";
import { AGENT_CONFIG_FILE, AGENT_MODELS_FILE, type ResolvedPlacement, resolveStateRoot, isUnderDir } from "./paths.ts";
import { dotEnvPath } from "./env.ts";
import { log } from "./log.ts";
import { openExternalUrl } from "./open-url.ts";
import { declaredChannels } from "./channels/discover.ts";
import { type Tunnel, announceWebhooks, startCloudflareTunnel } from "./tunnel.ts";

/** What the dev watcher restarts on (agent-dir-relative): the process-bound code inputs only. */
/** The agent-dir directories loaded ONCE per worker: a restart is their only re-read. */
const CODE_INPUT_DIRS = ["tools", "channels", "schedules", "extensions"] as const;

const WATCHED_HINT = `${CODE_INPUT_DIRS.map((dir) => `${dir}/`).join(", ")}, package.json, fastagent.config.ts, models.json, .secrets/.env`;

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
    // models.json is read ONCE per worker (the model hub is built during assembly), so an edit needs a restart like
    // any other code input.
    if (rel === AGENT_MODELS_FILE) return false;
    const segments = rel.split(sep);
    if (CODE_INPUT_DIRS.includes(segments[0] as (typeof CODE_INPUT_DIRS)[number])) return false;
    // The `.env` restarts too (credentials are process-bound).
    if (segments.length <= envRel.length && segments.every((seg, i) => seg === envRel[i])) return false;
    return true;
  };
}

/** Spawn the dev worker and restart it on agent-dir edits; supervise its lifecycle until the process exits. */
export async function runDevSupervisor(
  placement: ResolvedPlacement,
  options: { tunnel?: boolean } = {},
): Promise<void> {
  // The placement arrives RESOLVED from the command (which already routed its refusal through failStartup).
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
            void announceWebhooks(placement.agentDir, t.url, declaredChannels(m.routeChannels ?? []), {
              openUrl: openExternalUrl,
              stateRoot: resolveStateRoot(placement.agentDir),
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
        // workspace) that saving cannot fix.
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
      worker.kill("SIGTERM"); // the exit handler respawns once the port is released
    } else {
      spawnWorker(); // worker was down (broken edit) — retry now
    }
  };

  // chokidar gives reliable cross-platform recursion + structural ignore that native fs.watch cannot.
  const watcher = watchTree(placement.agentDir, {
    ignoreInitial: true, // the startup scan is not a change
    ignored: devWatchIgnored(placement.agentDir, dotEnvPath(placement.agentDir)),
  });
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(triggerReload, 200);
  });
  watcher.on("error", (error) =>
    log.warn(`[fastagent] file watching error (${(error as Error).message}); some edits may need a manual restart`),
  );
  log.info(
    `[fastagent] watching ${WATCHED_HINT} — code edits restart the dev worker (--no-watch to disable); AGENTS.md/persona.md/skills edits go live next turn without a restart`,
  );
  // FASTAGENT_SECRETS_DIR can move the `.env` OUT of the agent dir entirely.
  if (!isUnderDir(dotEnvPath(placement.agentDir), placement.agentDir)) {
    log.warn(
      `[fastagent] .env lives outside the agent dir (FASTAGENT_SECRETS_DIR → ${dotEnvPath(placement.agentDir)}) — it is NOT watched; restart dev after editing it`,
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
