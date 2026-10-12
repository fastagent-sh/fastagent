/**
 * `fastagent env` on the REAL mise: the agent's own, which the first `env add` puts into its package.json at the
 * newest version, so a mise release that changes any of these is caught here. The offline suite runs a stand-in that
 * does what each of these assumes; every one of them was first a guess that a run of mise answered:
 *
 * - `mise install <tool>@<version>` installs from the arguments alone, so an author's own mise.toml is not read;
 * - a version an install already matches is kept (`mise where jq@1` answers 1.7.1 while 1.8 is out), so a start has
 *   nothing to install and needs no network, and `mise install jq@1` then installs the newest 1.x;
 * - `mise tool <name> --json` names the backend a registry name resolves to (`tokei` is cargo, `php` is vfox);
 * - `MISE_PYTHON_COMPILE=false` refuses a runtime with no prebuilt build instead of compiling it;
 * - a PyPI package installs once the python and uv it declares are installed.
 *
 * Installs into a data directory of its own, never the machine's. Network only: no credential.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI, installSpec } from "./env.ts";

let agentDir = "";
let miseData = "";

const fastagent = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: agentDir,
      env: { ...process.env, MISE_DATA_DIR: miseData, MISE_CACHE_DIR: join(miseData, "cache") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

/** Declare `packages` in context.json by hand, as an author's edit would. */
async function declare(packages: Record<string, string>): Promise<void> {
  const context = JSON.parse(await readFile(join(agentDir, "context.json"), "utf8"));
  context.environment.packages = packages;
  await writeFile(join(agentDir, "context.json"), JSON.stringify(context));
}

beforeAll(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "fa-live-env-"));
  miseData = await mkdtemp(join(tmpdir(), "fa-live-env-mise-"));
  await writeFile(join(agentDir, "fastagent.config.ts"), "export default {};\n");
  await writeFile(
    join(agentDir, "package.json"),
    JSON.stringify({
      name: "agent",
      private: true,
      dependencies: { "@fastagent-sh/fastagent": await installSpec(agentDir) },
    }),
  );
  // The author's own, at another version: never read.
  await writeFile(join(agentDir, "mise.toml"), `[tools]\njq = "1.6"\n`);
});

afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
  await rm(miseData, { recursive: true, force: true });
});

describe("fastagent env on the real mise", () => {
  it("installs what context.json declares, and not the author's mise.toml", async () => {
    const add = await fastagent(["env", "add", "jq@1.7.1", "npm:cowsay@1"]);
    expect(add.code, add.stderr).toBe(0);
    const exec = await fastagent(["env", "exec", "--", "sh", "-c", "jq --version && cowsay --version"]);
    expect(exec.code, exec.stderr).toBe(0);
    expect(exec.stdout).toMatch(/^jq-1\.7\.1\n1\./);
  });

  it("keeps an install a version matches, so a start installs nothing; `env install` installs the newest", async () => {
    // jq 1.7.1 is installed, and the newest 1.x is newer: a start keeps 1.7.1.
    await declare({ jq: "1" });
    const start = await fastagent(["env", "exec", "--", "jq", "--version"]);
    expect(start.code, start.stderr).toBe(0);
    expect(start.stdout).toBe("jq-1.7.1\n");
    expect(start.stderr).not.toContain("installing the agent's packages");
    const install = await fastagent(["env", "install"]);
    expect(install.code, install.stderr).toBe(0);
    const after = await fastagent(["env", "exec", "--", "jq", "--version"]);
    expect(after.stdout).toMatch(/^jq-1\.(?!7\.1\n)\d+(\.\d+)?\n$/);
  });

  it("refuses by the backend mise resolves a registry name to", async () => {
    const tokei = await fastagent(["env", "add", "tokei"]);
    expect(tokei.code).toBe(1);
    expect(tokei.stderr).toMatch(/package "tokei" resolves to cargo:/);
    const php = await fastagent(["env", "add", "php"]);
    expect(php.code).toBe(1);
    expect(php.stderr).toMatch(/package "php" resolves to vfox:/);
  });

  it("refuses a runtime with no prebuilt build rather than compiling it", async () => {
    const python = await fastagent(["env", "add", "python@3.6.15"]);
    expect(python.code).toBe(1);
    expect(python.stderr).toMatch(/no precompiled python found/);
  });

  it("installs a PyPI package once the python and uv it declares are installed", async () => {
    const add = await fastagent(["env", "add", "python@3.12", "uv", "pypi:markitdown@0.1"]);
    expect(add.code, add.stderr).toBe(0);
    const exec = await fastagent(["env", "exec", "--", "markitdown", "--version"]);
    expect(exec.code, exec.stderr).toBe(0);
  });
});
