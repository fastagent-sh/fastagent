import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Run the CLI to completion; capture stdout, stderr, exit code. */
function run(
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

  it("models [search] filters by substring; a no-match prints nothing to stdout", async () => {
    const hit = await run(["models", "openai"]);
    expect(hit.code).toBe(0);
    expect(hit.stdout.trim().length).toBeGreaterThan(0);
    for (const line of hit.stdout.trim().split("\n")) expect(line.toLowerCase()).toContain("openai");
    const miss = await run(["models", "zzznope"]);
    expect(miss.stdout).toBe(""); // a no-match leaves stdout empty (pipe-friendly)
    expect(miss.stderr).toMatch(/no model matches/);
  });

  it("invoke without a message prints usage to stderr and exits 2 (stdout clean)", async () => {
    const { code, stdout, stderr } = await run(["invoke"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/usage: fastagent invoke/);
    expect(stdout).toBe("");
  });

  it("invoke surfaces a startup error to stderr, keeps stdout empty, exits non-zero", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-cli-inv-"));
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL; // no model source → assembly fails before any model call (no auth needed)
    const { code, stdout, stderr } = await run(["invoke", "hi", cwd], undefined, env);
    expect(code).toBe(1);
    expect(stderr).toMatch(/missing model/);
    expect(stdout).toBe(""); // a failure never pollutes stdout
  });

  it("info reports the assembled surface as JSON, read-only (no sessions dir created)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-info-"));
    await mkdir(join(dir, "skills", "greet"), { recursive: true });
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    await writeFile(
      join(dir, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greet warmly.\n---\nHi.\n",
    );
    await writeFile(
      join(dir, "channels", "github.ts"),
      'export default () => ({ "POST /x": () => new Response("ok") });\n',
    );
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;
    const { code, stdout } = await run(["info", dir, "--json"], undefined, env);
    expect(code).toBe(0); // an unset model is reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.model).toBeNull();
    expect(info.instructions).toBe(true);
    expect(info.skills.map((s: { name: string }) => s.name)).toEqual(["greet"]);
    expect(info.channels).toEqual(["github"]);
    await expect(stat(join(dir, ".fastagent"))).rejects.toThrow(); // read-only: never creates sessions dir
  });

  it("info surfaces a malformed skill as a diagnostic instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-info-"));
    await mkdir(join(dir, "skills", "bad"), { recursive: true });
    await writeFile(join(dir, "skills", "bad", "SKILL.md"), "---\nname: bad\n---\nno description.\n"); // no description
    const { code, stdout } = await run(["info", dir, "--json", "--model", "x/y"]);
    expect(code).toBe(0);
    const info = JSON.parse(stdout);
    expect(info.skills).toEqual([]); // the malformed skill is skipped, not loaded
    expect(JSON.stringify(info.diagnostics)).toMatch(/description/); // and surfaced as a diagnostic
  });
});
