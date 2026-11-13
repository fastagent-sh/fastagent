import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, run } from "../../doubles/cli-run.ts";

describe("cli: process contracts", () => {
  it("--version / -v prints the version to stdout and exits 0 (no parse crash)", async () => {
    const v = await run(["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await run(["-v"])).stdout.trim()).toBe(v.stdout.trim());
  });

  // One command is enough through the real binary: that a missing required argument is exit 2 on
  // EVERY command is cli-kernel.test.ts's, against the spec table.
  it("invoke without a message is a usage error on stderr, exits 2 (stdout clean)", async () => {
    const { code, stdout, stderr } = await run(["invoke"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/missing required argument 'message'/);
    expect(stdout).toBe("");
  });

  it("invoke surfaces a startup error to stderr, keeps stdout empty, exits non-zero", async () => {
    const cwd = await agentWorkspace("fa-cli-inv-");
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL; // no model source → assembly fails before any model call (no auth needed)
    const { code, stdout, stderr } = await run(["invoke", "hi", cwd], undefined, env);
    expect(code).toBe(2); // the choice a terminal's picker would have asked for: a usage error
    expect(stderr).toMatch(/missing model/);
    expect(stdout).toBe(""); // a failure never pollutes stdout
  });

  it("a directory that is not an agent fails as a one-line startup error, not a raw stack", async () => {
    // resolvePlacement throws SYNCHRONOUSLY, before any .catch(failStartup) chain exists — without
    // placementOrExit the refusal surfaced as an uncaught stack trace (found in acceptance).
    const dir = await mkdtemp(join(tmpdir(), "fa-not-an-agent-"));
    await writeFile(join(dir, "AGENTS.md"), "# just a project\n"); // context, not a definition
    const { code, stderr } = await run(["info", dir]);
    expect(code).toBe(1); // runtime failure, not a crash
    expect(stderr).toMatch(/^Error: .*not a fastagent agent.*fastagent init/); // the one-line failStartup presentation
    expect(stderr).not.toMatch(/\n\s+at /); // no stack frames — this is a user-fixable refusal, not a bug
  });
});
