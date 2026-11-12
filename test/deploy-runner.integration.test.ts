import { describe, expect, it } from "vitest";
import { spawnRunner } from "../src/deploy/runner.ts";

/**
 * Real child processes: the seam under test is the spawn wiring itself, which a fake would erase. What a call answers
 * (exit code, captured streams, a CLI not installed, `awsRunner`'s pager) is host-cli-double.integration.test.ts's.
 */
describe("spawnRunner", () => {
  it("still reports the exit code when the child exits WITHOUT reading stdin", async () => {
    // The host-CLI failure shape: `fly secrets set` / `railway variables set` rejects before
    // draining stdin, so the write lands on a closed pipe. Unhandled, that EPIPE is an uncaught
    // exception mid-deploy and the gate message the exit code carries is lost.
    const run = spawnRunner("sh", process.cwd());
    const result = await run(["-c", "exit 3"], { input: "x".repeat(1 << 20) });
    expect(result.code).toBe(3);
  });

  it("fails a child that exits 0 without reading all of its stdin — the input was truncated", async () => {
    // The hole a swallowed EPIPE leaves: the secrets a deploy feeds over stdin outrun the 64KB pipe
    // buffer, so a CLI that reports success having read a prefix would deploy half a credential and
    // the caller (which reads the exit code) would call it done.
    const run = spawnRunner("sh", process.cwd());
    const result = await run(["-c", "exit 0"], { input: "x".repeat(1 << 20) });
    expect(result.code).toBe(1);
  });
});
