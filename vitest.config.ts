import { defineConfig } from "vitest/config";

// A handful of CLI e2e tests spawn `node src/cli.ts <cmd>` subprocesses that each cold-start the full
// harness import graph (~0.7s+, measured; the pi packages, not TS stripping). They are deliberately few
// — only genuine process-level contracts (exit codes, stdout/stderr discipline, read-only invariants)
// live here; command LOGIC is unit-tested against the harness functions, not re-run through a subprocess.
// They are split by command across several files (listed in test/cli-run.ts, their shared spawn helper):
// vitest runs files in parallel but the tests inside one file serially, and as one file they were the
// suite's longest path.
//
// Under vitest's file-parallelism a contended machine can still push a cold-start past a tight timeout.
// The fix is the timeout, not a parallelism cap: a 30s ceiling absorbs a slow cold-start (including a
// dev machine loaded with other work) at near-zero cost — it only bites a genuinely-slow test.
//
// The suite is CPU-bound, so wall time ~ total CPU / cores. Measured (8 cores): ~145s wall, ~550s CPU; on a
// 4-vCPU CI runner the Test step takes ~125-150s. About 15 of ~165 files (the CLI subprocess ones) hold
// ~65% of that CPU. Capping vitest's workers (maxWorkers) cannot help: it only trades wall time for less
// contention. What does help is fewer or cheaper spawns, or more cores (`--shard`).
//
// `pool: "forks"` is explicit, not left to the default: it is the process isolation these
// subprocess / process.env tests assume.
export default defineConfig({
  // Scaffold templates import the PUBLISHED "@fastagent-sh/fastagent" (they are copied verbatim into user
  // workspaces — data to tsc, excluded from the program). Tests that EXECUTE a template resolve that
  // name to the current source instead: truer than dist/ (asserts the template against today's
  // defineTool), and dist/ doesn't exist on CI anyway. A subpath must be listed BEFORE the bare name:
  // a string alias also matches `<name>/...` and would rewrite the subpath onto index.ts.
  resolve: {
    alias: {
      "@fastagent-sh/fastagent/slack": new URL("./src/slack.ts", import.meta.url).pathname,
      "@fastagent-sh/fastagent/telegram": new URL("./src/telegram.ts", import.meta.url).pathname,
      "@fastagent-sh/fastagent/feishu": new URL("./src/feishu.ts", import.meta.url).pathname,
      "@fastagent-sh/fastagent/lark": new URL("./src/lark.ts", import.meta.url).pathname,
      "@fastagent-sh/fastagent": new URL("./src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    pool: "forks",
    setupFiles: ["test/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
