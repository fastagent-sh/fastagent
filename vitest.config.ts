import { defineConfig } from "vitest/config";

// Two tiers (CONTRIBUTING.md, "Test tiers"). Unit runs in one process, which test/unit-setup.ts enforces, and its
// ceiling finds a hung test fast. Integration runs real processes and builds on this machine. Both are hermetic
// (test/setup.ts).
//
// `pool: "forks"` is explicit, not left to the default: it is the process isolation these process.env tests assume.
const source = (name: string): string => new URL(`./packages/${name}/src`, import.meta.url).pathname;

export default defineConfig({
  // A package's source is what tests run, in process and in the Node processes they start (test/setup.ts names the
  // `@fastagent-sh/source` export condition for those). Scaffold templates import the PUBLISHED
  // "@fastagent-sh/fastagent"; tests that EXECUTE a template resolve it to the current source too. A subpath must be
  // listed BEFORE the bare name: a string alias also matches `<name>/...` and would rewrite the subpath onto index.ts.
  resolve: {
    alias: [
      { find: /^@fastagent-sh\/client\/(.+)$/, replacement: `${source("client")}/$1.ts` },
      { find: /^@fastagent-sh\/client$/, replacement: `${source("client")}/index.ts` },
      { find: /^@fastagent-sh\/fastagent\/(telegram|slack|feishu)$/, replacement: `${source("fastagent")}/$1.ts` },
      { find: /^@fastagent-sh\/fastagent$/, replacement: `${source("fastagent")}/index.ts` },
    ],
  },
  test: {
    pool: "forks",
    // A module a test imports natively (a built package's, outside Vite) reads the packages' source too.
    execArgv: ["--conditions=@fastagent-sh/source"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // In a random order, so no test leans on another having run first; a run prints its seed, and
          // `--sequence.seed=<n>` repeats it.
          sequence: { shuffle: { files: false, tests: true } },
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.integration.test.ts", "test/fixtures/.tmp-**"],
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
          exclude: ["test/fixtures/.tmp-**"],
          setupFiles: ["test/setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
