import { defineConfig } from "vitest/config";

// A handful of CLI e2e tests spawn `node src/cli.ts <cmd>` subprocesses that each cold-start the full
// engine import graph (~0.7s+, measured; the pi packages, not TS stripping). They are deliberately few
// — only genuine process-level contracts (exit codes, stdout/stderr discipline, read-only invariants)
// live here; command LOGIC is unit-tested against the engine functions, not re-run through a subprocess.
//
// Under vitest's file-parallelism a contended machine can still push a cold-start past a tight timeout.
// The fix is the timeout, not a parallelism cap: a 30s ceiling absorbs a slow cold-start (including a
// dev machine loaded with other work) at near-zero cost — it only bites a genuinely-slow test. Capping
// vitest's own workers (maxWorkers) was measured and rejected: it slows every run several-fold
// (17s -> ~60s here), is a no-op on a few-core CI runner, and can't touch external CPU load anyway.
//
// `pool: "forks"` is explicit, not left to the default: it is the process isolation these
// subprocess / process.env tests assume.
export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
