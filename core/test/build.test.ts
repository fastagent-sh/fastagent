import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArtifact, loadAgentDefinition, type ArtifactManifest } from "../src/index.ts";

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/**
 * A throwaway workspace exercising the full artifact surface: AGENTS.md, a local skill,
 * root-level authored context (docs/), config, a secret, deps, vcs, and a .gitignore'd file.
 */
async function makeWorkspace(opts: { config?: string; gitignore?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-build-ws-"));
  await writeFile(join(dir, "AGENTS.md"), "# Build Bot\nWhen asked about the schema, read docs/schema.md.\n");
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "schema.md"), "# Schema\nusers(id, name)\n");
  await mkdir(join(dir, "skills", "local-skill"), { recursive: true });
  await writeFile(
    join(dir, "skills", "local-skill", "SKILL.md"),
    "---\nname: local-skill\ndescription: A local skill.\n---\nLocal body.\n",
  );
  await writeFile(join(dir, ".env"), "SECRET=hunter2\n");
  await mkdir(join(dir, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(dir, "fastagent.config.mjs"), opts.config ?? `export default { model: "openai-codex/gpt-5.5" };`);
  if (opts.gitignore !== undefined) await writeFile(join(dir, ".gitignore"), opts.gitignore);
  return dir;
}

const freshOut = () => mkdtemp(join(tmpdir(), "fa-build-out-"));

describe("build: buildPiArtifact", () => {
  it("produces a self-contained artifact: AGENTS.md + skills + authored context + manifest", async () => {
    const ws = await makeWorkspace({ config: `export default { model: "openai-codex/gpt-5.5", http: { port: 9000 } };` });
    const out = await freshOut();
    const { manifest } = await buildPiArtifact(ws, out);

    expect(await readFile(join(out, "AGENTS.md"), "utf8")).toContain("Build Bot");
    expect((await readdir(join(out, "skills"))).sort()).toEqual(["local-skill"]);
    // authored context (root-level docs/) ships
    expect(await readFile(join(out, "docs", "schema.md"), "utf8")).toContain("users(id, name)");

    const onDisk = JSON.parse(await readFile(join(out, "fastagent.json"), "utf8")) as ArtifactManifest;
    expect(onDisk).toEqual(manifest);
    expect(onDisk.engine).toBe("pi");
    expect(onDisk.model).toBe("openai-codex/gpt-5.5");
    expect(onDisk.http).toEqual({ port: 9000 });
    expect(onDisk.fastagentVersion).toMatch(/^\d+\.\d+\.\d+/);

    // the artifact reloads on its own (relocatable, definition-only)
    const reloaded = await loadAgentDefinition(out, { skillPaths: [] });
    expect(reloaded.instructions).toContain("Build Bot");
    expect(reloaded.skills.map((s) => s.name)).toEqual(["local-skill"]);
  });

  it("excludes secrets / deps / vcs / machine-state unconditionally", async () => {
    const ws = await makeWorkspace();
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, ".env"))).toBe(false); // secret never bundled (red line)
    expect(await exists(join(out, "node_modules"))).toBe(false);
    expect(await exists(join(out, ".git"))).toBe(false);
    expect(await exists(join(out, ".fastagent"))).toBe(false);
  });

  it("honors the workspace .gitignore on top of the hard excludes", async () => {
    const ws = await makeWorkspace({ gitignore: "secrets.txt\nscratch/\n" });
    await writeFile(join(ws, "secrets.txt"), "do not ship\n");
    await mkdir(join(ws, "scratch"), { recursive: true });
    await writeFile(join(ws, "scratch", "note.md"), "scratch\n");
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, "secrets.txt"))).toBe(false);
    expect(await exists(join(out, "scratch"))).toBe(false);
    expect(await exists(join(out, "docs", "schema.md"))).toBe(true); // non-ignored authored context still ships
  });

  it("is non-destructive to the source tree", async () => {
    const ws = await makeWorkspace();
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    expect(await exists(join(ws, "AGENTS.md"))).toBe(true);
    expect(await exists(join(ws, "docs", "schema.md"))).toBe(true);
    expect(await exists(join(ws, ".env"))).toBe(true); // source secret untouched
  });

  it("materializes --global-skills into the artifact, never into the source", async () => {
    const home = await mkdtemp(join(tmpdir(), "fa-home-"));
    await mkdir(join(home, ".pi", "agent", "skills", "global-skill"), { recursive: true });
    await writeFile(
      join(home, ".pi", "agent", "skills", "global-skill", "SKILL.md"),
      "---\nname: global-skill\ndescription: A global skill.\n---\nGlobal body.\n",
    );
    const ws = await makeWorkspace();
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const off = await freshOut();
      await buildPiArtifact(ws, off);
      expect((await readdir(join(off, "skills"))).sort()).toEqual(["local-skill"]); // default: definition-only

      const on = await freshOut();
      await buildPiArtifact(ws, on, { globalSkills: true });
      expect((await readdir(join(on, "skills"))).sort()).toEqual(["global-skill", "local-skill"]);
      // the source skills/ is NOT mutated by materialization
      expect((await readdir(join(ws, "skills"))).sort()).toEqual(["local-skill"]);
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
      else delete process.env.HOME;
    }
  });

  it("model precedence: --model option beats config; bad/missing model fails before writing", async () => {
    const ws = await makeWorkspace({ config: `export default { model: "openai-codex/gpt-5.5" };` });
    const out = await freshOut();
    const { manifest } = await buildPiArtifact(ws, out, { model: "openai-codex/gpt-5.4" });
    expect(manifest.model).toBe("openai-codex/gpt-5.4");

    const bad = await freshOut();
    await expect(buildPiArtifact(ws, bad, { model: "nope/nothing" })).rejects.toThrow(/unknown model/);
    expect(await exists(join(bad, "fastagent.json"))).toBe(false);
  });

  it("rejects source/output aliasing and an output that contains the source (no data loss)", async () => {
    const ws = await makeWorkspace();
    await expect(buildPiArtifact(ws, ws)).rejects.toThrow(/must differ from the source/);
    await expect(buildPiArtifact(ws, join(ws, ".."))).rejects.toThrow(/must not contain the source/);
    // a symlinked out aliasing the source is caught via realpath
    const link = join(await mkdtemp(join(tmpdir(), "fa-build-link-")), "out");
    await symlink(ws, link);
    await expect(buildPiArtifact(ws, link)).rejects.toThrow(/must differ from the source/);
    expect(await exists(join(ws, "AGENTS.md"))).toBe(true); // source intact throughout
  });

  it("builds into the default in-tree out (.fastagent/build) without copying it into itself", async () => {
    const ws = await makeWorkspace();
    const out = join(ws, ".fastagent", "build"); // the CLI default — inside the source tree
    await buildPiArtifact(ws, out);
    expect(await readFile(join(out, "AGENTS.md"), "utf8")).toContain("Build Bot");
    expect(await exists(join(out, "docs", "schema.md"))).toBe(true);
    // the artifact must not contain a nested copy of itself / .fastagent
    expect(await exists(join(out, ".fastagent"))).toBe(false);
  });

  it("deterministic rebuild: a file dropped from the source does not survive in the artifact", async () => {
    const ws = await makeWorkspace();
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, "docs", "schema.md"))).toBe(true);

    await rm(join(ws, "docs"), { recursive: true });
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, "docs"))).toBe(false); // stale authored context gone
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
  });
});
