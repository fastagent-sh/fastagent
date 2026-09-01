import { defineConfig } from "vitest/config";

/**
 * The live probes (`npm run test:live`): real providers, the real registry, a real container — so a
 * container build and a registry install get minutes, not the offline suite's seconds. Serial by file,
 * because these probes compete for the Docker daemon and one provider's rate limit.
 *
 * Standalone rather than merged with vitest.config.ts: `mergeConfig` CONCATENATES include/exclude, and
 * the whole point of the split is that each config runs the other's files not at all.
 */
export default defineConfig({
  test: {
    include: ["test/live/*.live.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
