import { describe, expect, it, vi } from "vitest";
import ignore from "ignore";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefinition, loadSourceDefinition } from "../../../packages/fastagent/src/harnesses/assembly.ts";
import { readSkills } from "../../../packages/fastagent/src/harnesses/text.ts";
import { scaffoldAgent } from "../../../packages/fastagent/src/scaffold/init.ts";
import { besideAgent, runInProcess } from "../../doubles/cli-run.ts";
import { exists, freshDir } from "../../fixtures/init-fixtures.ts";

vi.mock("../../../packages/fastagent/src/git.ts", () => import("../../doubles/git-double.ts"));

describe("init: scaffoldAgent", () => {
  it("scaffolds a COMPLETE agent INTO the directory it names", async () => {
    const dir = join(await freshDir(), "reviewer");
    const { created, mode } = await scaffoldAgent(dir);
    expect(mode).toBe("fresh");
    expect(created.sort()).toEqual(
      [
        "SYSTEM.md",
        join("skills", "writing-great-skills", "SKILL.md"),
        join("skills", "writing-great-skills", "GLOSSARY.md"),
        join("skills", "writing-great-skills", "LICENSE"),
        "fastagent.config.ts",
        "package.json",
        ".gitignore",
        join(".secrets", ".env.example"),
        join(".secrets", ".gitignore"),
      ].sort(),
    );

    const rootIgnore = await readFile(join(dir, ".gitignore"), "utf8");
    const ig = ignore({ ignorecase: false }).add(rootIgnore);
    expect(ig.ignores(".env")).toBe(true);
    expect(ig.ignores(".env.local")).toBe(true);
    const secretsIgnore = ignore({ ignorecase: false }).add(
      await readFile(join(dir, ".secrets", ".gitignore"), "utf8"),
    );
    expect(secretsIgnore.ignores(".env")).toBe(true);
    expect(secretsIgnore.ignores(".env.example")).toBe(false);

    expect(rootIgnore).toMatch(/^node_modules$/m);
    expect(ig.ignores(".fastagent/dist/index.js")).toBe(true);
    expect(await readFile(join(dir, ".secrets", ".gitignore"), "utf8")).toMatch(/^\*$/m);

    const envExample = await readFile(join(dir, ".secrets", ".env.example"), "utf8");
    expect(envExample).toMatch(/fastagent login/);
    expect(envExample).toMatch(/set a provider API key/);
    expect(envExample).not.toMatch(/FASTAGENT_AGENT/);
    for (const line of envExample.split("\n")) {
      if (line.trim() !== "") expect(line.startsWith("#")).toBe(true);
    }

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.type).toBe("module");
    expect(pkg.name).toBe("reviewer");
    expect(pkg.scripts).toEqual({
      dev: "fastagent dev",
      build: "fastagent build",
      start: "fastagent build && fastagent start",
    });
    const real = JSON.parse(
      await readFile(fileURLToPath(new URL("../../../packages/fastagent/package.json", import.meta.url)), "utf8"),
    ) as {
      version: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({
      "@fastagent-sh/fastagent": `^${real.version}`,
    });
    expect(pkg.devDependencies).toEqual({ typescript: real.devDependencies.typescript });
    const standing = await readFile(join(dir, "SYSTEM.md"), "utf8");
    expect(standing).toContain("Use only the tools actually listed in your system prompt");
    expect(standing).not.toMatch(/workspace/i);

    const definition = await loadSourceDefinition(dir);
    expect(definition.name).toBe("reviewer");
    expect(buildDefinition(definition, {})).toMatchObject({ tools: [] });
    expect(readSkills(dir).map((s) => s.name)).toEqual(["writing-great-skills"]);
  });

  it("treats empty, placeholder-only, or Git-only directories as fresh starts and refuses unrelated non-empty directories", async () => {
    const project = await freshDir();
    await writeFile(join(project, "tsconfig.json"), "{}");
    await writeFile(join(project, "AGENTS.md"), "# Host repo guidance\n");
    await expect(scaffoldAgent(project)).rejects.toThrow(
      /is not empty \(it holds AGENTS\.md, tsconfig\.json\).*fastagent init agents\/support/,
    );
    expect(await exists(join(project, "SYSTEM.md"))).toBe(false);

    const noisy = await freshDir();
    for (const noise of [".DS_Store", ".gitkeep"]) await writeFile(join(noisy, noise), "");
    await mkdir(join(noisy, ".git"));
    const freshResult = await scaffoldAgent(noisy);
    expect(freshResult.mode).toBe("fresh");
    expect(freshResult.created).toContain("SYSTEM.md");
    expect(freshResult.created).toContain(join("skills", "writing-great-skills", "SKILL.md"));

    const deep = join(await freshDir(), "some", "agent");
    await scaffoldAgent(deep);
    expect(await exists(join(deep, "SYSTEM.md"))).toBe(true);
  });

  it("adopts an existing agent directory in place without overwriting author files or adding the example skill, and is idempotent on rerun", async () => {
    const dir = await freshDir();
    const promptBytes = "You triage billing incidents concisely.\n";
    const skillBytes = "---\nname: triage\ndescription: Triage incidents\n---\nCheck logs first.\n";
    await writeFile(join(dir, "SYSTEM.md"), promptBytes);
    await mkdir(join(dir, "skills", "triage"), { recursive: true });
    await writeFile(join(dir, "skills", "triage", "SKILL.md"), skillBytes);
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "billing-triage", scripts: { test: "vitest" }, customField: true }, null, 2)}\n`,
    );

    const adopted = await scaffoldAgent(dir);
    expect(adopted.mode).toBe("existing");
    expect(adopted.dependenciesChanged).toBe(true);
    expect(adopted.preserved).toContain("SYSTEM.md");
    expect(adopted.updated).toContain("package.json");
    expect(adopted.created).toContain("fastagent.config.ts");
    expect(await readFile(join(dir, "SYSTEM.md"), "utf8")).toBe(promptBytes);
    expect(await readFile(join(dir, "skills", "triage", "SKILL.md"), "utf8")).toBe(skillBytes);
    expect(await exists(join(dir, "skills", "writing-great-skills"))).toBe(false);
    expect(readSkills(dir).map((s) => s.name)).toEqual(["triage"]);

    const mergedPkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(mergedPkg.name).toBe("billing-triage");
    expect(mergedPkg.customField).toBe(true);
    expect(mergedPkg.type).toBe("module");
    expect(mergedPkg.scripts).toMatchObject({ test: "vitest", dev: "fastagent dev", build: "fastagent build" });

    // Re-running on a ready directory makes zero changes and does not reserialize package.json.
    const rawManifest = await readFile(join(dir, "package.json"), "utf8");
    const rerun = await scaffoldAgent(dir);
    expect(rerun.mode).toBe("existing");
    expect(rerun.created).toEqual([]);
    expect(rerun.updated).toEqual([]);
    expect(rerun.dependenciesChanged).toBe(false);
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(rawManifest);
    expect(await exists(join(dir, "skills", "writing-great-skills"))).toBe(false);
  });

  it("checks effective ignore rules including later negations while preserving author rules", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "SYSTEM.md"), "Prompt.\n");
    await writeFile(join(dir, ".gitignore"), "custom-build/\nnode_modules\n/dist\n!/dist\n.env\n!.env\n");
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".gitignore"), "*\n");

    const adopted = await scaffoldAgent(dir);
    expect(adopted.updated).toContain(".gitignore");
    expect(adopted.updated).toContain(join(".secrets", ".gitignore"));

    const rootText = await readFile(join(dir, ".gitignore"), "utf8");
    expect(rootText).toContain("custom-build/");
    const rootIg = ignore({ ignorecase: false }).add(rootText);
    expect(rootIg.ignores("dist/index.js")).toBe(true);
    expect(rootIg.ignores(".env")).toBe(true);
    expect(rootIg.ignores(".env.local")).toBe(true);
    expect(rootIg.ignores(".fastagent/dev/agent.sqlite")).toBe(true);
    expect(rootIg.ignores(".state/agent.sqlite")).toBe(true);

    const secretsIg = ignore({ ignorecase: false }).add(await readFile(join(dir, ".secrets", ".gitignore"), "utf8"));
    expect(secretsIg.ignores(".env")).toBe(true);
    expect(secretsIg.ignores("auth.json")).toBe(true);
    expect(secretsIg.ignores(".env.example")).toBe(false);
    expect(secretsIg.ignores(".gitignore")).toBe(false);
  });

  it("refuses module, script, dependency, dist, nested-agent, and symlink conflicts without partial writes", async () => {
    // 1) CommonJS package.json
    const cjs = await freshDir();
    await writeFile(join(cjs, "SYSTEM.md"), "Prompt.\n");
    await writeFile(join(cjs, "package.json"), JSON.stringify({ name: "host", type: "commonjs" }));
    await expect(scaffoldAgent(cjs)).rejects.toThrow(/type.*"commonjs".*fastagent init agents\/support/);
    expect(await exists(join(cjs, "fastagent.config.ts"))).toBe(false);

    // 2) Implicit CommonJS (.js files without type: "module")
    const looseJs = await freshDir();
    await writeFile(join(looseJs, "SYSTEM.md"), "Prompt.\n");
    await writeFile(join(looseJs, "server.js"), "module.exports = {};\n");
    await writeFile(join(looseJs, "package.json"), JSON.stringify({ name: "host" }));
    await expect(scaffoldAgent(looseJs)).rejects.toThrow(/omits "type": "module" while \.js files exist/);
    expect(await exists(join(looseJs, "fastagent.config.ts"))).toBe(false);

    // 3) Conflicting build script
    const conflictingScript = await freshDir();
    await writeFile(join(conflictingScript, "SYSTEM.md"), "Prompt.\n");
    await writeFile(
      join(conflictingScript, "package.json"),
      JSON.stringify({ name: "host", type: "module", scripts: { build: "vite build" } }),
    );
    await expect(scaffoldAgent(conflictingScript)).rejects.toThrow(/conflicting "build" script/);
    expect(await exists(join(conflictingScript, "fastagent.config.ts"))).toBe(false);

    // 4) Unrecognized or incompatible dependency version spec
    const badSpec = await freshDir();
    await writeFile(join(badSpec, "SYSTEM.md"), "Prompt.\n");
    await writeFile(
      join(badSpec, "package.json"),
      JSON.stringify({ name: "host", type: "module", dependencies: { "@fastagent-sh/fastagent": "latest" } }),
    );
    await expect(scaffoldAgent(badSpec)).rejects.toThrow(/unrecognized version spec "latest"/);
    expect(await exists(join(badSpec, "fastagent.config.ts"))).toBe(false);

    const tooOld = await freshDir();
    await writeFile(join(tooOld, "SYSTEM.md"), "Prompt.\n");
    await writeFile(
      join(tooOld, "package.json"),
      JSON.stringify({ name: "host", type: "module", dependencies: { "@fastagent-sh/fastagent": "^0.1.0" } }),
    );
    await expect(scaffoldAgent(tooOld)).rejects.toThrow(/incompatible version "\^0\.1\.0"/);
    expect(await exists(join(tooOld, "fastagent.config.ts"))).toBe(false);

    const unbounded = await freshDir();
    await writeFile(join(unbounded, "SYSTEM.md"), "Prompt.\n");
    await writeFile(
      join(unbounded, "package.json"),
      JSON.stringify({ name: "host", type: "module", dependencies: { "@fastagent-sh/fastagent": ">=0.38.0" } }),
    );
    await expect(scaffoldAgent(unbounded)).rejects.toThrow(/unrecognized version spec ">=0\.38\.0"/);
    expect(await exists(join(unbounded, "fastagent.config.ts"))).toBe(false);

    const prerelease = await freshDir();
    await writeFile(join(prerelease, "SYSTEM.md"), "Prompt.\n");
    await writeFile(
      join(prerelease, "package.json"),
      JSON.stringify({
        name: "host",
        type: "module",
        dependencies: { "@fastagent-sh/fastagent": "0.38.0-alpha.1" },
      }),
    );
    await expect(scaffoldAgent(prerelease)).rejects.toThrow(/incompatible prerelease version "0\.38\.0-alpha\.1"/);
    expect(await exists(join(prerelease, "fastagent.config.ts"))).toBe(false);

    // 5) Unrelated dist/ (even with a dummy build.json) is refused; a FastAgent dist/ is accepted untouched.
    const hostDist = await freshDir();
    await writeFile(join(hostDist, "SYSTEM.md"), "Prompt.\n");
    await mkdir(join(hostDist, "dist"), { recursive: true });
    await writeFile(join(hostDist, "dist", "build.json"), JSON.stringify({ code: [], fingerprint: "abc" }));
    await writeFile(join(hostDist, "dist", "index.js"), "console.log('host');\n");
    await expect(scaffoldAgent(hostDist)).rejects.toThrow(/does not look like a FastAgent build output/);
    expect(await exists(join(hostDist, "fastagent.config.ts"))).toBe(false);

    const faDist = await freshDir();
    await writeFile(join(faDist, "SYSTEM.md"), "Prompt.\n");
    await mkdir(join(faDist, "dist"), { recursive: true });
    const buildJson = JSON.stringify({ code: ["fastagent.config.ts"], fingerprint: "stale" });
    const entryJs = "// Generated by fastagent build: do not edit.\nexport default defineDefinition({});\n";
    await writeFile(join(faDist, "dist", "build.json"), buildJson);
    await writeFile(join(faDist, "dist", "index.js"), entryJs);
    await scaffoldAgent(faDist);
    expect(await readFile(join(faDist, "dist", "build.json"), "utf8")).toBe(buildJson);

    // 6) Symlink write target outside target directory is refused.
    const symDir = await freshDir();
    await writeFile(join(symDir, "SYSTEM.md"), "Prompt.\n");
    const outsideTarget = besideAgent(symDir, "outside-pkg.json");
    await writeFile(outsideTarget, JSON.stringify({ name: "outside", type: "module" }));
    await symlink(outsideTarget, join(symDir, "package.json"));
    await expect(scaffoldAgent(symDir)).rejects.toThrow(/refusing to write through symlink "package\.json"/);
    expect(await exists(join(symDir, "fastagent.config.ts"))).toBe(false);

    // 7) Nested directory inside an enclosing agent is refused.
    const outer = await freshDir();
    await scaffoldAgent(outer);
    await expect(scaffoldAgent(join(outer, "nested"))).rejects.toThrow(/is inside the agent/);
  });

  it("CLI `fastagent init` defaults to `.` and `--no-install` reports skipped installation", async () => {
    const dir = await freshDir();
    const res = await runInProcess(["init", "--no-install"], dir);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("dependencies: skipped (--no-install)");
    expect(await exists(join(dir, "fastagent.config.ts"))).toBe(true);

    const dotDir = await freshDir();
    await writeFile(join(dotDir, "SYSTEM.md"), "Existing.\n");
    const dotRes = await runInProcess(["init", ".", "--no-install"], dotDir);
    expect(dotRes.code, dotRes.stderr).toBe(0);
    expect(dotRes.stderr).toContain("fastagent info --json");
    expect(await exists(join(dotDir, "skills", "writing-great-skills"))).toBe(false);
  });
});
