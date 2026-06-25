import { defineConfig } from "vitest/config";

// The CLI e2e tests spawn `node src/cli.ts <cmd>` subprocesses that each cold-start the full engine
// import graph (~0.7s+, measured; the pi packages, not TS stripping). Under vitest's default
// file-parallelism a contended machine can push a cold-start past the 5s default per-test timeout —
// flaky under load, while a small CI runner squeaks by because it spawns fewer.
//
// The fix is the timeout, not a parallelism cap. A 20s ceiling absorbs a slow cold-start from any
// cause at near-zero cost — it only bites when a test is genuinely slow. Capping vitest's own workers
// (maxWorkers) was measured and rejected: it slows every run several-fold (17s -> ~60s here), is a
// no-op on a CI runner with few cores, and can't touch the real culprit on a dev machine — external
// CPU load (browsers, editors), which no test-runner setting controls.
//
// `pool: "forks"` is explicit, not left to the default: it is the process isolation these
// subprocess / process.env tests assume.
export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
