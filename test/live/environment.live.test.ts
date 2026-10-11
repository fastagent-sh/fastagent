/**
 * `fastagent env` on the REAL mise: the agent's own, which the first `env add` puts into its package.json at the
 * newest version, so a mise release that changes any of these is caught here. The offline suite runs a stand-in that
 * does what each of these assumes; every one of them was first a guess that a run of mise overturned:
 *
 * - mise does not read the ceiling directory itself, so an author's own mise.toml beside context.json is not read;
 * - `mise lock --platform linux-x64,linux-arm64` records those platforms alone, and twice is byte for byte the same;
 * - an install over a copy of the lock follows the versions it records and resolves what it lacks;
 * - `mise tool <name> --json` names the backend a registry name resolves to (`tokei` is cargo, `php` is vfox);
 * - `<runtime>.compile = false` refuses a runtime with no prebuilt build instead of compiling it (python by default);
 * - a PyPI package locks once its uv is installed.
 *
 * Network only: no credential.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI, installSpec } from "./env.ts";

let agentDir = "";

const fastagent = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: agentDir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const lock = () => readFile(join(agentDir, "environment", "mise.lock"), "utf8");

beforeAll(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "fa-live-env-"));
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
  await writeFile(join(agentDir, "mise.toml"), `[tools]\njq = "1.7.1"\n`);
});

afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

describe("fastagent env on the real mise", () => {
  it("locks the image's platforms alone, from context.json and not the author's mise.toml", async () => {
    const add = await fastagent(["env", "add", "jq@1.7", "npm:cowsay@1"]);
    expect(add.code, add.stderr).toBe(0);
    const locked = await lock();
    expect(locked).toMatch(/\[\[tools\.jq\]\]\nversion = "1\.7"\n/);
    expect([...new Set(locked.match(/platforms\.[a-z0-9-]+/g))].sort()).toEqual([
      "platforms.linux-arm64",
      "platforms.linux-x64",
    ]);
    expect(locked).toContain(".mise/locks/npm-cowsay/");
  });

  it("locks byte for byte the same when nothing changed", async () => {
    const before = await lock();
    const install = await fastagent(["env", "install"]);
    expect(install.code, install.stderr).toBe(0);
    expect(install.stderr).not.toContain("locked again");
    expect(await lock()).toBe(before);
  });

  it("runs the locked versions, resolves what the lock lacks, and writes nothing in environment/", async () => {
    const before = await lock();
    const context = JSON.parse(await readFile(join(agentDir, "context.json"), "utf8"));
    context.environment.packages.yq = "4";
    await writeFile(join(agentDir, "context.json"), JSON.stringify(context));
    const exec = await fastagent(["env", "exec", "--", "sh", "-c", "jq --version && yq --version"]);
    expect(exec.code, exec.stderr).toBe(0);
    expect(exec.stdout).toMatch(/^jq-1\.7\n.*yq.* version v4\./s);
    expect(await lock()).toBe(before);
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

  it("locks a PyPI package once the uv it declares is installed", async () => {
    const add = await fastagent(["env", "add", "python@3.12", "uv", "pypi:markitdown@0.1"]);
    expect(add.code, add.stderr).toBe(0);
    expect(await lock()).toMatch(/\[\[tools\."pypi:markitdown"\]\]\nversion = "0\.1\.\d+"/);
  });
});
