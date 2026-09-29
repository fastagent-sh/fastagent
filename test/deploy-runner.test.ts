import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { awsRunner, spawnRunner } from "../src/deploy/runner.ts";

/** Real child processes: the seam under test is the spawn wiring itself, which a fake would erase. */
describe("spawnRunner", () => {
  it("resolves 127 when the binary is not on PATH, so callers gate with an install hint", async () => {
    const run = spawnRunner("fastagent-no-such-binary-xyz", process.cwd());
    expect((await run(["--version"], { capture: true })).code).toBe(127);
  });

  it("captures stdout and the exit code", async () => {
    const run = spawnRunner("sh", process.cwd());
    const result = await run(["-c", "printf hello; exit 0"], { capture: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("still reports the exit code when the child exits WITHOUT reading stdin", async () => {
    // The host-CLI failure shape: `fly secrets import` / `railway variables set` rejects before
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

describe("awsRunner", () => {
  it("runs the AWS CLI with its pager off, whatever the operator's environment says", async () => {
    const bin = await mkdtemp(join(tmpdir(), "fa-aws-"));
    await writeFile(join(bin, "aws"), '#!/bin/sh\nprintf "pager=[%s] %s" "$AWS_PAGER" "$*"\n');
    await chmod(join(bin, "aws"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("AWS_PAGER", "less");
    try {
      const run = awsRunner(process.cwd());
      expect((await run(["ecr", "create-repository"], { capture: true })).stdout).toBe(
        "pager=[] ecr create-repository",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
