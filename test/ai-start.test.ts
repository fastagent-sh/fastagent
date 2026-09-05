import assert from "node:assert/strict";
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
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "fa-ai-start-")));
  const agentDir = join(workspace, "fastagent");
  const node = (args: string[], cwd = workspace) => exec(process.execPath, args, { cwd, timeout: 25_000 });
  const cli = (args: string[]) => node([join(root, "src/cli.ts"), ...args]);
  try {
    await cli(["init", ".", "--no-install"]);
    const config = await readFile(join(agentDir, "fastagent.config.mjs"), "utf8");
    for (const file of [
      "tsconfig.json",
      "persona.md",
      "skills/review-batches/SKILL.md",
      "lib/batches.ts",
      "tools/plan-batches.ts",
      "test/batches.test.ts",
      "schedules/daily-review.ts",
    ]) {
      const path = join(agentDir, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, snippet(`fastagent/${file}`));
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
      workspace,
      agentDir,
      persona: true,
      tools: expect.arrayContaining(["fetch-url", "plan-batches"]),
      skills: expect.arrayContaining([expect.objectContaining({ name: "review-batches" })]),
      schedules: [expect.objectContaining({ name: "daily-review", cron: "0 9 * * *" })],
      toolError: null,
      toolFailures: [],
      scheduleFailures: [],
      diagnostics: [],
    });
    expect(await readFile(join(agentDir, "fastagent.config.mjs"), "utf8")).toBe(config);

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
    await rm(workspace, { recursive: true, force: true });
  }
});
