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
    const { created, skipped } = await scaffoldWorkspace(dir);
    expect(created.sort()).toEqual(
      ["AGENTS.md", ".gitignore", "fastagent.config.mjs", join("skills", "house-style", "SKILL.md")].sort(),
    );
    expect(skipped).toEqual([]);

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

  it("creates a non-existent target dir", async () => {
    const base = await freshDir();
    const target = join(base, "nested", "agent");
    await scaffoldWorkspace(target);
    expect(await exists(join(target, "AGENTS.md"))).toBe(true);
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

  it("keeps a pre-existing non-identity file (.gitignore), still scaffolds the rest", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, ".gitignore"), "custom\n");
    const { created, skipped } = await scaffoldWorkspace(dir);
    expect(skipped).toEqual([".gitignore"]);
    expect(created).toContain("AGENTS.md");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("custom\n"); // user's kept
  });
});
