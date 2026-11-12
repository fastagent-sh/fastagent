import { describe, expect, it } from "vitest";
import { agentWorkspace, built, run } from "./cli-run.ts";

/**
 * The commander kernel: specs-as-data rendered through buildProgram. In-process tests drive the
 * program with injected IO (no spawn, no process.exit); a few spawn tests at the end verify the
 * cli.ts delegation wiring end to end.
 */

// ---------------------------------------------------------------------------------------------
// End-to-end through cli.ts: the delegation seam (kernel commands bypass the legacy parseArgs).

describe("cli end to end: the thin entry", () => {
  it("models --help renders the generated per-command help (exit 0)", async () => {
    const { code, stdout, stderr } = await run(["models", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage: fastagent models/);
    expect(stderr).toBe("");
  });

  it("schedules list on an empty dir reads cleanly: data to stdout, message to stderr, exit 0", async () => {
    const dir = await agentWorkspace("fa-kernel-sched-");
    const { code, stdout, stderr } = await run(["schedules", "list", dir]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/nothing scheduled/);
  });

  it("invoke with no message is a usage error from the kernel: exit 2", async () => {
    const { code, stderr } = await run(["invoke"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/missing required argument 'message'/);
  });

  it("exit codes follow responsibility: bad --port flag → 2 (usage), bad PORT env → 1 (config)", async () => {
    const dir = await built(await agentWorkspace("fa-kernel-port-"));
    const flag = await run(["start", dir, "--port", "abc"]);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toMatch(/invalid --port/);
    const env = await run(["start", dir], undefined, {
      ...process.env,
      PORT: "abc",
      FASTAGENT_MODEL: "openai/gpt-5.5",
    });
    expect(env.code).toBe(1);
    expect(env.stderr).toMatch(/invalid PORT env/);
  });
});
