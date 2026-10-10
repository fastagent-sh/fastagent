import assert from "node:assert/strict";
import { withGitIdentity } from "./git-env.ts";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const guide = await readFile(new URL("../docs/ai-start.md", import.meta.url), "utf8");

function snippet(file: string): string {
  const section = guide.split(`**\`${file}\`**`)[1];
  const code = section?.match(/```[^\n]*\n([\s\S]*?)\n```/)?.[1];
  assert(code, `Missing code block for ${file} in docs/ai-start.md`);
  return `${code}\n`;
}

it("the agent development guide's copied files typecheck, run, and reject a mistyped helper call", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "fa-ai-start-")));
  const agentDir = join(parent, "my-agent");
  // Per-process, so a hung step fails naming its own command instead of the whole test.
  const env = withGitIdentity; // `init` commits
  const node = (args: string[], cwd = agentDir) => exec(process.execPath, args, { cwd, env, timeout: 60_000 });
  const cli = (args: string[]) => node([join(root, "src/cli.ts"), ...args]);
  try {
    await node([join(root, "src/cli.ts"), "init", "my-agent", "--no-install"], parent);
    const config = await readFile(join(agentDir, "fastagent.config.ts"), "utf8");
    for (const file of [
      "tsconfig.json",
      "APPEND_SYSTEM.md",
      "skills/review-batches/SKILL.md",
      "lib/batches.ts",
      "tools/plan-batches.ts",
      "test/batches.test.ts",
      "schedules/daily-review.md",
    ]) {
      const path = join(agentDir, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, snippet(file));
    }

    // Like Vitest's alias, resolve public imports to current source without an install or stale dist/.
    const alias = join(agentDir, "node_modules/@fastagent-sh/fastagent");
    await mkdir(alias, { recursive: true });
    await writeFile(
      join(alias, "package.json"),
      JSON.stringify({ type: "module", exports: { types: "./index.d.ts", default: "./index.js" } }),
    );
    const reexport = `export * from ${JSON.stringify(join(root, "src/index.ts"))};\n`;
    await writeFile(join(alias, "index.js"), reexport);
    await writeFile(join(alias, "index.d.ts"), reexport);
    await symlink(join(root, "node_modules/@types"), join(agentDir, "node_modules/@types"), "dir");

    const tsc = join(root, "node_modules/typescript/bin/tsc");
    await node([tsc, "--noEmit"], agentDir);
    await node(["--test", "test/batches.test.ts"], agentDir);
    const tool = await cli(["tool", "plan-batches", '{"items":5,"size":2}']);
    expect(JSON.parse(tool.stdout)).toEqual({ batches: 3 });
    const info = JSON.parse((await cli(["info", "--json"])).stdout);
    expect(info).toMatchObject({
      agentDir,
      content: [],
      appendSystemPrompt: join(agentDir, "APPEND_SYSTEM.md"),
      tools: expect.arrayContaining(["plan-batches"]),
      skills: expect.arrayContaining([expect.objectContaining({ name: "review-batches" })]),
      schedules: [expect.objectContaining({ name: "daily-review", cron: "0 9 * * *" })],
      toolError: null,
      toolFailures: [],
      scheduleFailures: [],
      diagnostics: [],
    });
    expect(await readFile(join(agentDir, "fastagent.config.ts"), "utf8")).toBe(config);

    const testFile = join(agentDir, "test/batches.test.ts");
    const valid = await readFile(testFile, "utf8");
    expect(valid).toContain("batchCount(5, 2)");
    await writeFile(testFile, valid.replace("batchCount(5, 2)", 'batchCount("5", 2)'));
    await expect(node([tsc, "--noEmit"], agentDir)).rejects.toMatchObject({
      stdout: expect.stringContaining("TS2345"),
    });
    const files = (await readdir(agentDir, { recursive: true })).filter((file) => !file.startsWith("node_modules/"));
    expect(files.filter((file) => /\.(?:js|d\.ts|map|tsbuildinfo)$/.test(file))).toEqual([]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
  // Its OWN ceiling: seven subprocesses, two of them full `tsc` runs — ~14s idle here, which leaves
  // the global 30s no room for contention (a loaded dev machine and a few-core CI runner are the
  // same case). CPU-bound work scales with the load; the timeout is what absorbs it (vitest.config.ts).
}, 120_000);
