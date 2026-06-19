import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiAgentFromWorkspace, loadAgentDefinition, scaffoldWorkspace } from "../src/index.ts";

const freshDir = () => mkdtemp(join(tmpdir(), "fa-init-"));
async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
/** Run `fastagent <args>` from `cwd` to completion; return stderr (the [fastagent] report stream). */
function cliInit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", () => resolve(stderr));
  });
}

describe("init: scaffoldWorkspace", () => {
  it("default scaffolds a COMPLETE agent (instructions + skill + a code tool + package.json)", async () => {
    const dir = await freshDir();
    const { complete, created, warnings } = await scaffoldWorkspace(dir);
    expect(complete).toBe(true);
    expect(created).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        join("skills", "house-style", "SKILL.md"),
        join("tools", "word-count.ts"),
        "fastagent.config.mjs",
        "package.json",
        ".npmrc",
        ".gitignore",
        ".env.example",
      ]),
    );
    expect(warnings).toEqual([]);

    // .env.example documents env knobs without misleading: all-commented (sets nothing), and it
    // states the default model uses OAuth (`pi login`), never implying an API key is required.
    const envExample = await readFile(join(dir, ".env.example"), "utf8");
    expect(envExample).toMatch(/pi login/);
    expect(envExample).toMatch(/OAuth, not an API key/);
    for (const line of envExample.split("\n")) {
      if (line.trim() !== "") expect(line.startsWith("#")).toBe(true); // every non-blank line is a comment
    }

    // package.json is ESM with the tool's deps; the tool imports the package + names from its file.
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@kid7st/fastagent"]).toBeDefined();
    expect(pkg.dependencies.zod).toBeDefined();
    expect(await readFile(join(dir, "tools", "word-count.ts"), "utf8")).toContain('from "@kid7st/fastagent"');
    expect(await readFile(join(dir, ".npmrc"), "utf8")).toContain("npm.pkg.github.com");

    // AGENTS.md + skill load as a definition offline (loadAgentDefinition does not touch tools/).
    const def = await loadAgentDefinition(dir);
    expect(def.skills.map((s) => s.name)).toEqual(["house-style"]);
    expect(def.collisions).toEqual([]);
  });

  it("--minimal scaffolds the markdown-only unit (no package.json/tool) and assembles fully offline", async () => {
    const dir = await freshDir();
    const { complete, created } = await scaffoldWorkspace(dir, { minimal: true });
    expect(complete).toBe(false);
    expect(created.sort()).toEqual(
      ["AGENTS.md", ".gitignore", ".env.example", "fastagent.config.mjs", join("skills", "house-style", "SKILL.md")].sort(),
    );
    expect(await exists(join(dir, "package.json"))).toBe(false);
    expect(await exists(join(dir, "tools"))).toBe(false);

    // No tool to import → dev assembles with zero edits and zero network.
    const { agent, modelSpec } = await createPiAgentFromWorkspace(dir);
    expect(typeof agent.invoke).toBe("function");
    expect(modelSpec).toBe("openai-codex/gpt-5.5");
  });

  it("creates a non-existent target dir (counts as empty, no non-empty note)", async () => {
    const base = await freshDir();
    const target = join(base, "nested", "agent");
    const { intoNonEmpty } = await scaffoldWorkspace(target);
    expect(await exists(join(target, "AGENTS.md"))).toBe(true);
    expect(intoNonEmpty).toBe(false);
  });

  it("preflights blocking parent paths: a file named `skills` fails BEFORE writing AGENTS.md (retryable)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "skills"), "i am a file, not a dir\n"); // blocks skills/house-style/
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/"skills" exists and is not a directory/);
    // no half-scaffold: AGENTS.md was never written, so a retry is not blocked by the guard
    expect(await exists(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("rejects a symlinked scaffold parent (does not follow it and write outside the workspace)", async () => {
    const external = await freshDir(); // a dir OUTSIDE the workspace
    const dir = await freshDir();
    await symlink(external, join(dir, "skills")); // `skills` is a symlink → must be rejected, not followed
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/"skills" exists and is not a directory/);
    expect(await exists(join(dir, "AGENTS.md"))).toBe(false); // nothing written in the workspace
    expect(await readdir(external)).toEqual([]); // and nothing escaped into the symlink target
  });

  it("rolls back the scaffold when the .env advisory read throws (unreadable ignore file), keeping retry clean", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, ".fastagentignore")); // a dir where a file is expected → loadRootIgnore throws
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/cannot read .*\.fastagentignore/);
    // the advisory read sits inside the rollback scope → the scaffolded AGENTS.md was removed,
    // so a retry is not blocked by the overwrite guard
    expect(await exists(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("refuses to overwrite an existing workspace (AGENTS.md or a config), leaving it intact", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "AGENTS.md"), "# My real agent\n");
    await expect(scaffoldWorkspace(dir)).rejects.toThrow(/already has AGENTS\.md .* refuses to overwrite/);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("# My real agent\n"); // untouched

    const dir2 = await freshDir();
    await writeFile(join(dir2, "fastagent.config.ts"), "export default {};\n");
    await expect(scaffoldWorkspace(dir2)).rejects.toThrow(/already has fastagent\.config\.ts/);
  });

  it("prints a `cd <dir>` step for a named target so the dev/.env/config steps are correct", async () => {
    const base = await freshDir();
    // init into a subdir from `base` as cwd: the next steps must lead with `cd my-agent`.
    const named = await cliInit(["init", "my-agent", "--no-install"], base);
    expect(named).toMatch(/cd my-agent/);
    // init into cwd (default .): no cd step, bare `fastagent dev` is already correct.
    const cwd = await cliInit(["init", "--no-install"], await freshDir());
    expect(cwd).not.toMatch(/cd /);
    expect(cwd).toMatch(/fastagent dev/);
  });

  it("keeps a pre-existing .gitignore; warns when it does not ignore .env (build could ship secrets)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), "custom\n"); // no .env rule
    const { created, skipped, intoNonEmpty, warnings } = await scaffoldWorkspace(dir);
    expect(skipped).toEqual([".gitignore"]);
    expect(created).toContain("AGENTS.md");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("custom\n"); // kept, NOT mutated
    expect(intoNonEmpty).toBe(true); // the dir already had the .gitignore
    expect(warnings).toEqual([expect.stringMatching(/does not exclude "\.env"/)]);
  });

  it("does not warn when a kept .gitignore already covers .env", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), "node_modules/\n*.env\n"); // *.env covers .env
    const { skipped, warnings } = await scaffoldWorkspace(dir);
    expect(skipped).toEqual([".gitignore"]);
    expect(warnings).toEqual([]);
  });

  // The advisory must mirror build's matcher (loadRootIgnore: .gitignore + .fastagentignore,
  // fa last, case-SENSITIVE), or it gives false assurance in the dangerous direction.
  it("warns on a case-mismatched rule (.ENV does not exclude .env under build's case-sensitive matcher)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), ".ENV\n"); // wrong case → build (ignorecase:false) ships .env
    const { warnings } = await scaffoldWorkspace(dir);
    expect(warnings).toEqual([expect.stringMatching(/does not exclude "\.env"/)]);
  });

  it("warns when .fastagentignore re-includes .env (applied last, authoritative — build ships it)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), ".env\n"); // git excludes it …
    await writeFile(join(dir, ".fastagentignore"), "!.env\n"); // … but fa un-excludes it (last wins)
    const { warnings } = await scaffoldWorkspace(dir);
    expect(warnings).toEqual([expect.stringMatching(/does not exclude "\.env"/)]);
  });

  it("does not warn when .fastagentignore excludes .env though the kept .gitignore does not (combined matcher)", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), "node_modules/\n"); // kept, NO .env rule
    await writeFile(join(dir, ".fastagentignore"), ".env\n"); // fa covers it → build excludes
    const { skipped, warnings } = await scaffoldWorkspace(dir);
    expect(skipped).toEqual([".gitignore"]);
    expect(warnings).toEqual([]);
  });
});
