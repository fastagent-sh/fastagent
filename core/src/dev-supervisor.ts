/**
 * The `fastagent dev` process supervisor — the watch-and-restart mechanism behind the dev command.
 *
 * It re-spawns the CLI itself as a worker (`FASTAGENT_DEV_WORKER=1`) and restarts that worker on
 * debounced workspace edits. Each restart is a FRESH process (always-latest, no stale module cache).
 * The supervisor never exits on a bad edit — the worker fails loudly (its own startup error) and the
 * supervisor waits for the next save. This is process orchestration, not assembly: it lives outside
 * cli.ts's command dispatch (and outside the engine), holding only the dev process lifecycle.
 */
import { spawn } from "node:child_process";
import { watch as watchTree } from "chokidar";

/** Spawn the dev worker and restart it on workspace edits; supervise its lifecycle until the process exits. */
export function runDevSupervisor(dir: string): void {
  let worker: ReturnType<typeof spawn> | undefined;
  let reloadPending = false;
  let everServed = false; // has any worker successfully bound (sent `ready`) yet?
  let timer: NodeJS.Timeout | undefined;

  const spawnWorker = (): void => {
    // ipc fd so the worker can signal readiness once it binds; stdio otherwise inherited.
    // biome-ignore lint/style/noNonNullAssertion: argv[1] is always the script path under a node entry
    const w = spawn(process.execPath, [process.argv[1]!, ...process.argv.slice(2)], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, FASTAGENT_DEV_WORKER: "1" },
    });
    worker = w;
    w.on("message", (m: { type?: string }) => {
      if (m?.type === "ready") everServed = true;
    });
    w.on("exit", (code, signal) => {
      if (worker !== w) return; // already superseded
      worker = undefined;
      if (reloadPending) {
        reloadPending = false;
        spawnWorker(); // restart requested: the old worker has now exited, so the port is free
      } else if (!everServed) {
        // The worker failed BEFORE ever serving — a non-editable startup failure (bad flag,
        // EADDRINUSE, broken initial workspace) that saving cannot fix. Propagate the exit code so
        // `fastagent dev` fails like the old CLI did (and smoke tests don't hang). The worker
        // already printed the specific error (inherited stdio).
        process.exit(code ?? 1);
      } else {
        // A worker that HAD been serving stopped (a broken edit, or a crash). The edit is fixable;
        // the error is already printed. Wait for the next save to retry, do not loop or exit.
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

  // Recursively watch the workspace, structurally ignoring machine-state dirs. The worker writes
  // jsonl sessions DEEP under .fastagent on every invoke, so watching it would restart dev on its
  // own writes; node_modules/.git are noise. Everything else is watched — tools, skills, AND helper
  // dirs a tool/config imports (e.g. lib/) — so a saved transitive import triggers the fresh-process
  // reload too. chokidar gives reliable cross-platform recursion + structural ignore that native
  // fs.watch cannot (its `filename` is not guaranteed, defeating a path-based filter).
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
    void watcher.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  spawnWorker();
}
