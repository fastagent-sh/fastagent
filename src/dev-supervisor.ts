/**
 * The `fastagent dev` process supervisor: re-spawn the CLI as a worker (`FASTAGENT_DEV_WORKER=1`) and
 * restart it on debounced edits to the workspace's CODE inputs. Each restart is a fresh process
 * (always-latest, no stale module cache). The supervisor never exits on a bad edit — the worker fails
 * loudly and it waits for the next save.
 *
 * Watch scope is deliberately narrow: only inputs whose changes REQUIRE a new process — imported
 * code (tools/, channels/), fastagent.config.*, package.json, .env. The definition (AGENTS.md,
 * skills/) is re-read per invoke by the folder rung, so its edits go live on the next turn with no
 * restart — and, critically, an agent that writes files into its own workspace (its normal work
 * product, including editing its own AGENTS.md) never has its in-flight turn killed by the watcher.
 */
import { spawn } from "node:child_process";
import { relative, sep } from "node:path";
import { watch as watchTree } from "chokidar";
import { log } from "./log.ts";
import { installProxyFetch } from "./proxy.ts";
import { type Tunnel, announceWebhooks, startCloudflareTunnel } from "./tunnel.ts";

/** What the dev watcher restarts on (workspace-relative): the process-bound code inputs only. */
export const WATCHED_HINT = "tools/, channels/, fastagent.config.*, package.json, .env";

/**
 * chokidar `ignored` matcher for the narrow watch scope (true = ignore). Ignoring a directory prunes
 * the whole subtree, so everything outside the allowlist — .fastagent state, node_modules, .git, and
 * any file/dir the agent writes as work product — costs no watchers and triggers no restarts.
 * Helper code imported from OUTSIDE tools//channels/ is out of scope by design (keep it under
 * tools/, or restart manually) — the startup log names the watched set.
 */
export function devWatchIgnored(root: string): (path: string) => boolean {
  return (path: string): boolean => {
    const rel = relative(root, path);
    if (rel === "" || rel === ".") return false; // the root itself must not be pruned
    const [head] = rel.split(sep);
    if (head === "tools" || head === "channels") return false; // watched subtrees, fully
    if (rel === "package.json" || rel === ".env") return false;
    if (/^fastagent\.config\.[cm]?[jt]s$/.test(rel)) return false;
    return true;
  };
}

/** Spawn the dev worker and restart it on workspace edits; supervise its lifecycle until the process exits. */
export function runDevSupervisor(dir: string, options: { tunnel?: boolean } = {}): void {
  let worker: ReturnType<typeof spawn> | undefined;
  let reloadPending = false;
  let everServed = false; // has any worker successfully bound (sent `ready`) yet?
  let timer: NodeJS.Timeout | undefined;
  // The supervisor owns the tunnel so the public URL survives worker reloads (a fresh tunnel per save
  // would mean a new URL + re-registering the webhook on every edit).
  let tunnel: Tunnel | undefined;
  // The supervisor itself calls the channel webhook APIs (setWebhook) when announcing the tunnel, so
  // it needs the proxy too (workers install their own). A region-blocked api.telegram.org fails otherwise.
  if (options.tunnel) installProxyFetch();

  const spawnWorker = (): void => {
    // ipc fd so the worker can signal readiness once it binds; stdio otherwise inherited.
    // biome-ignore lint/style/noNonNullAssertion: argv[1] is always the script path under a node entry
    const w = spawn(process.execPath, [process.argv[1]!, ...process.argv.slice(2)], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, FASTAGENT_DEV_WORKER: "1" },
    });
    worker = w;
    w.on("message", (m: { type?: string; port?: number }) => {
      if (m?.type !== "ready") return;
      everServed = true;
      // Start the tunnel once, on the first worker that binds; reuse it across reloads.
      if (options.tunnel && !tunnel && typeof m.port === "number") {
        void startCloudflareTunnel(m.port).then((t) => {
          if (t) {
            tunnel = t;
            void announceWebhooks(dir, t.url);
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
        // Failed BEFORE ever serving — a non-editable startup failure (bad flag, EADDRINUSE, broken
        // initial workspace) that saving cannot fix. Propagate the exit code (the worker already
        // printed the error via inherited stdio).
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

  // chokidar gives reliable cross-platform recursion + structural ignore that native fs.watch
  // cannot; devWatchIgnored (above) narrows the scope to the process-bound code inputs.
  const watcher = watchTree(dir, {
    ignoreInitial: true, // the startup scan is not a change
    ignored: devWatchIgnored(dir),
  });
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(triggerReload, 200);
  });
  watcher.on("error", (error) =>
    log.warn(`[fastagent] file watching error (${(error as Error).message}); some edits may need a manual restart`),
  );
  log.info(
    `[fastagent] watching ${WATCHED_HINT} — code edits restart the dev worker (--no-watch to disable); AGENTS.md/skills edits go live next turn without a restart`,
  );

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
