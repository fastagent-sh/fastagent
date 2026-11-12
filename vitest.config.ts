import { defineConfig } from "vitest/config";

// Two tiers (CONTRIBUTING.md, "Test tiers"). Unit runs in one process, which test/unit-setup.ts enforces, and its
// ceiling finds a hung test fast. Integration runs real processes and builds on this machine. Both are hermetic
// (test/setup.ts).
//
// `pool: "forks"` is explicit, not left to the default: it is the process isolation these process.env tests assume.
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
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // In a random order, so no test leans on another having run first; a run prints its seed, and
          // `--sequence.seed=<n>` repeats it.
          sequence: { shuffle: { files: false, tests: true } },
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.integration.test.ts"],
          setupFiles: ["test/setup.ts", "test/unit-setup.ts"],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/**/*.integration.test.ts"],
          setupFiles: ["test/setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
