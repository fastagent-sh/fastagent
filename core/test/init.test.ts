import { describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgentFromWorkspace, loadAgentDefinition, scaffoldWorkspace } from "../src/index.ts";

const freshDir = () => mkdtemp(join(tmpdir(), "fa-init-"));
async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

describe("init: scaffoldWorkspace", () => {
  it("scaffolds a workspace that loads and assembles offline (init → dev is self-contained)", async () => {
    const dir = await freshDir();
    const { created, skipped, intoNonEmpty, warnings } = await scaffoldWorkspace(dir);
    expect(created.sort()).toEqual(
      ["AGENTS.md", ".gitignore", "fastagent.config.mjs", join("skills", "house-style", "SKILL.md")].sort(),
    );
    expect(skipped).toEqual([]);
    // fresh empty dir, and our own .gitignore ignores .env → no advisories
    expect(intoNonEmpty).toBe(false);
    expect(warnings).toEqual([]);

    // The scaffold is a valid definition: AGENTS.md + the example skill, no diagnostics/collisions.
    const def = await loadAgentDefinition(dir);
    expect(def.instructions).toContain("concise");
    expect(def.skills.map((s) => s.name)).toEqual(["house-style"]);
    expect(def.diagnostics).toEqual([]);
    expect(def.collisions).toEqual([]);

    // dev assembly works with zero edits and zero network (model is resolved from the registry).
    const { agent, modelSpec } = await createPiAgentFromWorkspace(dir);
    expect(typeof agent.invoke).toBe("function");
    expect(modelSpec).toBe("openai-codex/gpt-5.5");

    // .gitignore wires up the "secrets are the user's responsibility" model from the start.
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".env");
  });

  it("creates a non-existent target dir (counts as empty, no non-empty note)", async () => {
    const base = await freshDir();
    const target = join(base, "nested", "agent");
    const { intoNonEmpty } = await scaffoldWorkspace(target);
    expect(await exists(join(target, "AGENTS.md"))).toBe(true);
    expect(intoNonEmpty).toBe(false);
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
