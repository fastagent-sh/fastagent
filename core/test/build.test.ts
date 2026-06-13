import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildPiArtifact, loadAgentDefinition, type ArtifactManifest } from "../src/index.ts";

const execFileAsync = promisify(execFile);
async function gitInit(dir: string): Promise<void> {
  await execFileAsync("git", ["-C", dir, "init", "-q"]);
}

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

  it("excludes deps / vcs / machine-state unconditionally (not security — correctness/bloat)", async () => {
    const ws = await makeWorkspace();
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, "node_modules"))).toBe(false);
    expect(await exists(join(out, ".git"))).toBe(false);
    expect(await exists(join(out, ".fastagent"))).toBe(false);
  });

  it("does not special-case .env: ships in a bare folder (user's responsibility), excluded by git/.fastagentignore", async () => {
    // Non-repo, no ignore file → .env ships. Security is the user's responsibility by design.
    const ws = await makeWorkspace();
    const bare = await freshOut();
    await buildPiArtifact(ws, bare);
    expect(await exists(join(bare, ".env"))).toBe(true);
    // The user excludes it via .fastagentignore …
    await writeFile(join(ws, ".fastagentignore"), ".env\n");
    const ignored = await freshOut();
    await buildPiArtifact(ws, ignored);
    expect(await exists(join(ignored, ".env"))).toBe(false);
    // … or, in a git repo, by .gitignore (the convention).
    const repo = await makeWorkspace();
    await writeFile(join(repo, ".gitignore"), ".env\n");
    await gitInit(repo);
    const out = await freshOut();
    await buildPiArtifact(repo, out);
    expect(await exists(join(out, ".env"))).toBe(false);
  });

  it("honors .fastagentignore (non-repo: the whole tree ships minus those + hard excludes)", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws, ".fastagentignore"), "secrets.txt\nscratch/\n");
    await writeFile(join(ws, "secrets.txt"), "do not ship\n");
    await mkdir(join(ws, "scratch"), { recursive: true });
    await writeFile(join(ws, "scratch", "note.md"), "scratch\n");
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, "secrets.txt"))).toBe(false);
    expect(await exists(join(out, "scratch"))).toBe(false);
    expect(await exists(join(out, "docs", "schema.md"))).toBe(true); // non-ignored authored context still ships
  });

  it("delegates ignore semantics to git in a repo: .gitignore'd files do not ship, .git is excluded", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws, ".gitignore"), "scratch/\n");
    await mkdir(join(ws, "scratch"), { recursive: true });
    await writeFile(join(ws, "scratch", "note.md"), "scratch\n");
    await gitInit(ws); // now git decides the ship-set (untracked-non-ignored)
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, "scratch"))).toBe(false); // git-ignored → not shipped
    expect(await exists(join(out, ".git"))).toBe(false); // the repo dir is never bundled
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
    expect(await exists(join(out, "docs", "schema.md"))).toBe(true);
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

  it("materialized global skills apply the hard excludes (deps/vcs), not security (.env ships)", async () => {
    const home = await mkdtemp(join(tmpdir(), "fa-home-"));
    const skill = join(home, ".pi", "agent", "skills", "leaky");
    await mkdir(join(skill, "node_modules", "junk"), { recursive: true });
    await mkdir(join(skill, ".git"), { recursive: true });
    await writeFile(join(skill, ".git", "HEAD"), "x\n");
    await writeFile(join(skill, "SKILL.md"), "---\nname: leaky\ndescription: x.\n---\nb\n");
    await writeFile(join(skill, ".env"), "SKILL_SECRET=topsecret\n");
    await writeFile(join(skill, "node_modules", "junk", "i.js"), "x\n");
    await writeFile(join(skill, "ref.md"), "legit reference\n"); // a real bundled resource
    const ws = await makeWorkspace();
    const out = await freshOut();
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      await buildPiArtifact(ws, out, { globalSkills: true });
      expect(await exists(join(out, "skills", "leaky", "ref.md"))).toBe(true); // skill content ships
      expect(await exists(join(out, "skills", "leaky", "node_modules"))).toBe(false); // dep/bloat excluded
      expect(await exists(join(out, "skills", "leaky", ".git"))).toBe(false); // vcs excluded
      // .env is NOT special-cased (security is the user's responsibility); for an external
      // skill there is no ignore mechanism, so its .env ships.
      expect(await exists(join(out, "skills", "leaky", ".env"))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
      else delete process.env.HOME;
    }
  });

  it("dereferences a symlinked directory into the artifact (no silent drop)", async () => {
    const shared = await mkdtemp(join(tmpdir(), "fa-shared-"));
    await writeFile(join(shared, "schema.md"), "# shared\nusers(id)\n");
    const ws = await makeWorkspace();
    await rm(join(ws, "docs"), { recursive: true });
    await symlink(shared, join(ws, "docs")); // docs/ is a symlink to a directory
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    // the symlinked dir's contents must be dereferenced into the artifact
    expect(await readFile(join(out, "docs", "schema.md"), "utf8")).toContain("users(id)");
  });

  it("preserves two sibling symlinks to the same directory (cycle guard is per-descent)", async () => {
    const shared = await mkdtemp(join(tmpdir(), "fa-shared-"));
    await writeFile(join(shared, "file.md"), "shared content\n");
    const ws = await makeWorkspace();
    await symlink(shared, join(ws, "a"));
    await symlink(shared, join(ws, "b")); // distinct destination, same target — not a cycle
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, "a", "file.md"))).toBe(true);
    expect(await exists(join(out, "b", "file.md"))).toBe(true); // the second alias must NOT be dropped
  });

  it("does not loop on a symlink cycle", async () => {
    const ws = await makeWorkspace();
    await symlink(".", join(ws, "loop")); // loop -> the workspace itself (its own ancestor)
    const out = await freshOut();
    await buildPiArtifact(ws, out); // must terminate, not hang/overflow
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
  });

  it("fails visibly when the ship-set excludes a loaded definition file (no silent drop)", async () => {
    const ws = await makeWorkspace();
    await mkdir(join(ws, "skills", "secret"), { recursive: true });
    await writeFile(join(ws, "skills", "secret", "SKILL.md"), "---\nname: secret\ndescription: x.\n---\nb\n");
    await writeFile(join(ws, ".fastagentignore"), "skills/secret/\n"); // excludes a skill the agent loads
    const out = await freshOut();
    await expect(buildPiArtifact(ws, out)).rejects.toThrow(/excluded from the artifact/);
  });

  it("recognizes an in-tree out even when src and out are spelled through different symlinks", async () => {
    const real = await mkdtemp(join(tmpdir(), "fa-build-real-"));
    await writeFile(join(real, "AGENTS.md"), "# Bot\n");
    await writeFile(join(real, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    const link = join(await mkdtemp(join(tmpdir(), "fa-build-link-")), "ws");
    await symlink(real, link); // src reached via a symlink alias
    const out = join(real, "build"); // out under the real source dir (an in-tree out)
    await buildPiArtifact(link, out); // must not descend into the artifact it creates
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
    expect(await exists(join(out, "build"))).toBe(false); // no nested build/build recursion
  });

  it("fails visibly on an unreadable .fastagentignore (only ENOENT is normal)", async () => {
    const ws = await makeWorkspace();
    await mkdir(join(ws, ".fastagentignore")); // a directory where a file is expected → read fails (not ENOENT)
    const out = await freshOut();
    await expect(buildPiArtifact(ws, out)).rejects.toThrow(/cannot read .*\.fastagentignore/);
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

  it("refuses to overwrite existing non-artifact output; source stays intact; rebuild is idempotent", async () => {
    const ws = await makeWorkspace();
    // --out at an existing authored subtree would rm it; refused, source untouched.
    await expect(buildPiArtifact(ws, join(ws, "docs"))).rejects.toThrow(/not a prior fastagent artifact/);
    expect(await exists(join(ws, "docs", "schema.md"))).toBe(true);
    // out == src is rejected too (any guard); source intact.
    await expect(buildPiArtifact(ws, ws)).rejects.toThrow();
    expect(await exists(join(ws, "AGENTS.md"))).toBe(true);
    // a prior artifact dir (a VALID manifest) may be rebuilt into.
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, "fastagent.json"))).toBe(true);

    // a user file merely NAMED fastagent.json does not license deleting the dir.
    const ws2 = await makeWorkspace();
    await writeFile(join(ws2, "docs", "fastagent.json"), `{"example":"not our manifest"}\n`);
    await expect(buildPiArtifact(ws2, join(ws2, "docs"))).rejects.toThrow(/not a prior fastagent artifact/);
    expect(await exists(join(ws2, "docs", "schema.md"))).toBe(true); // authored content intact
  });

  it(".fastagentignore patterns stay artifact-relative inside a symlinked-dir subtree", async () => {
    // A workspace .fastagentignore rule `docs/private.md` must hold even when docs/ is a
    // symlink whose subtree restarts the git base; otherwise the path anchor mis-roots.
    const shared = await mkdtemp(join(tmpdir(), "fa-shared-"));
    await writeFile(join(shared, "pub.md"), "public\n");
    await writeFile(join(shared, "private.md"), "SECRET\n");
    const ws = await makeWorkspace();
    await symlink(shared, join(ws, "docs2"));
    await writeFile(join(ws, ".fastagentignore"), "docs2/private.md\n");
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, "docs2", "pub.md"))).toBe(true);
    expect(await exists(join(out, "docs2", "private.md"))).toBe(false); // anchored rule honored
  });

  it("refuses --out at .fastagent/sessions (only .fastagent/build is owned), keeping session state", async () => {
    const ws = await makeWorkspace();
    const sessions = join(ws, ".fastagent", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "conv.jsonl"), "history\n");
    await expect(buildPiArtifact(ws, sessions)).rejects.toThrow(/not a prior fastagent artifact/);
    expect(await exists(join(sessions, "conv.jsonl"))).toBe(true); // session history untouched
  });

  it("a submodule (gitlink) ships under ITS OWN git rules, not the whole working tree", async () => {
    // A submodule is a nested repo; its own .gitignore must decide what ships.
    const ws = await makeWorkspace();
    const sub = join(ws, "vendor");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "doc.md"), "shipped reference\n");
    await writeFile(join(sub, "secret.env"), "LEAK=no\n");
    await writeFile(join(sub, ".gitignore"), "secret.env\n");
    await gitInit(sub); // nested repo (acts as the submodule's checked-out tree)
    await gitInit(ws);
    const out = await freshOut();
    await buildPiArtifact(ws, out);
    expect(await exists(join(out, "vendor", "doc.md"))).toBe(true); // tracked content ships
    expect(await exists(join(out, "vendor", "secret.env"))).toBe(false); // submodule .gitignore honored
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
