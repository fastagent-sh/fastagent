/**
 * The `fastagent dev` process supervisor: re-spawn the CLI as a worker (`FASTAGENT_DEV_WORKER=1`) and
 * restart it on debounced workspace edits. Each restart is a fresh process (always-latest, no stale
 * module cache). The supervisor never exits on a bad edit — the worker fails loudly and it waits for
 * the next save.
 */
import { spawn } from "node:child_process";
import { watch as watchTree } from "chokidar";
import { type Tunnel, announceWebhooks, startCloudflareTunnel } from "./tunnel.ts";

/** Spawn the dev worker and restart it on workspace edits; supervise its lifecycle until the process exits. */
export function runDevSupervisor(dir: string, options: { tunnel?: boolean } = {}): void {
  let worker: ReturnType<typeof spawn> | undefined;
  let reloadPending = false;
  let everServed = false; // has any worker successfully bound (sent `ready`) yet?
  let timer: NodeJS.Timeout | undefined;
  // The supervisor owns the tunnel so the public URL survives worker reloads (a fresh tunnel per save
  // would mean a new URL + re-registering the webhook on every edit).
  let tunnel: Tunnel | undefined;

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
        console.error(`[fastagent] dev stopped (worker exited: ${signal ?? code}) — save a change to retry`);
      }
    });
  };

  const triggerReload = (): void => {
    console.error(`[fastagent] change detected — restarting…`);
    if (worker) {
      reloadPending = true;
      worker.kill("SIGTERM"); // the exit handler respawns once the port is released
    } else {
      spawnWorker(); // worker was down (broken edit) — retry now
    }
  };

  // Recursively watch the workspace, structurally ignoring machine-state dirs: the worker writes
  // jsonl sessions under .fastagent on every invoke (watching it would restart dev on its own
  // writes); node_modules/.git are noise. Everything else — tools, skills, helper dirs a tool/config
  // imports — is watched. chokidar gives reliable cross-platform recursion + structural ignore that
  // native fs.watch cannot.
  const watcher = watchTree(dir, {
    ignoreInitial: true, // the startup scan is not a change
    ignored: /(?:^|[\\/])(?:\.fastagent|node_modules|\.git)(?:[\\/]|$)/,
  });
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(triggerReload, 200);
  });
  watcher.on("error", (error) =>
    console.error(
      `[fastagent] warn: file watching error (${(error as Error).message}); some edits may need a manual restart`,
    ),
  );
  console.error(`[fastagent] watching for changes — edits restart the dev worker (--no-watch to disable)`);

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
