// The CLI as a subprocess, for the process-contract tests: cli.test.ts, cli-deploy*.test.ts,
// cli-schedules-tool.test.ts, cli-info.test.ts, cli-login.test.ts and cli-kernel.test.ts's end-to-end block.
// Each run cold-starts the engine, so these tests are spread across files by command to let vitest run them
// in parallel; one file runs its tests serially.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** An agent directory, as `init` produces one; `files` land in it. */
export async function agentWorkspace(prefix: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n"); // THE marker
  await writeFile(join(dir, ".secrets", "auth.json"), "{}\n"); // a real credential to leak
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, dirname(name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** Run the CLI to completion; capture stdout, stderr, exit code. */
export function run(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { ...(cwd ? { cwd } : {}), env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
