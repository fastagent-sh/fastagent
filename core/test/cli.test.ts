import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Run the CLI to completion; capture stdout, stderr, exit code. */
function run(args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], cwd ? { cwd } : {});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("cli papercuts", () => {
  it("--version / -v prints the version to stdout and exits 0 (no parse crash)", async () => {
    const v = await run(["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await run(["-v"])).stdout.trim()).toBe(v.stdout.trim());
  });

  it("init shows an absolute `cd` for a target outside cwd (not a ../../.. climb)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-cli-cwd-"));
    const target = await mkdtemp(join(tmpdir(), "fa-cli-tgt-")); // a sibling temp dir, outside cwd
    const { stderr } = await run(["init", target, "--minimal"], cwd);
    expect(stderr).toMatch(/cd \/.*fa-cli-tgt/); // absolute path
    expect(stderr).not.toMatch(/cd \.\./); // never the ../../.. noise
  });

  it("build warns that a .env is not bundled (its secrets must come from the deploy env)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-cli-env-"));
    await writeFile(join(dir, "AGENTS.md"), "# Bot\n");
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    await writeFile(join(dir, ".env"), "GITHUB_WEBHOOK_SECRET=x\n");
    const { stderr } = await run(["build", dir]);
    expect(stderr).toMatch(/\.env is not in the artifact/);
  });
});
