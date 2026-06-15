import { describe, expect, it } from "vitest";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPiArtifact,
  loadAgentDefinition,
  type ArtifactManifest,
  type BuildPiArtifactOptions,
} from "../src/index.ts";

// Tests build to an isolated temp dir OUTSIDE the throwaway workspace (hermeticity); that
// out-of-tree path needs force, which the real default (.fastagent/build, in-tree) does
// not. The dedicated guard tests below call buildPiArtifact directly to exercise force.
const buildOk = (src: string, out: string, opts: BuildPiArtifactOptions = {}) =>
  buildPiArtifact(src, out, { force: true, ...opts });

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
    const { manifest } = await buildOk(ws, out);

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

  it("does not expose the destructive bundler publicly (buildPiArtifact is the guarded entry)", async () => {
    const pub = await import("../src/index.ts");
    expect("buildPiArtifact" in pub).toBe(true);
    expect("bundleAgentDefinition" in pub).toBe(false); // internal: its rm -rf has no public guard
  });

  it("excludes deps / vcs / machine-state unconditionally (not security — correctness/bloat)", async () => {
    const ws = await makeWorkspace();
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "node_modules"))).toBe(false);
    expect(await exists(join(out, ".git"))).toBe(false);
    expect(await exists(join(out, ".fastagent"))).toBe(false);
  });

  it("does not special-case .env: ships in a bare folder (user's responsibility), excluded by git/.fastagentignore", async () => {
    // Non-repo, no ignore file → .env ships. Security is the user's responsibility by design.
    const ws = await makeWorkspace();
    const bare = await freshOut();
    await buildOk(ws, bare);
    expect(await exists(join(bare, ".env"))).toBe(true);
    // The user excludes it via .fastagentignore …
    await writeFile(join(ws, ".fastagentignore"), ".env\n");
    const ignored = await freshOut();
    await buildOk(ws, ignored);
    expect(await exists(join(ignored, ".env"))).toBe(false);
    // … or by .gitignore (the convention), honored whether or not git is installed.
    const repo = await makeWorkspace();
    await writeFile(join(repo, ".gitignore"), ".env\n");
    const out = await freshOut();
    await buildOk(repo, out);
    expect(await exists(join(out, ".env"))).toBe(false);
  });

  it("honors .fastagentignore (non-repo: the whole tree ships minus those + hard excludes)", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws, ".fastagentignore"), "secrets.txt\nscratch/\n");
    await writeFile(join(ws, "secrets.txt"), "do not ship\n");
    await mkdir(join(ws, "scratch"), { recursive: true });
    await writeFile(join(ws, "scratch", "note.md"), "scratch\n");
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "secrets.txt"))).toBe(false);
    expect(await exists(join(out, "scratch"))).toBe(false);
    expect(await exists(join(out, "docs", "schema.md"))).toBe(true); // non-ignored authored context still ships
  });

  it("excludes a file whose name starts with .. (e.g. ..secret.env) when a rule matches it", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws, ".fastagentignore"), "*.env\n");
    await writeFile(join(ws, "..secret.env"), "S\n"); // a forward filename that begins with ..
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "..secret.env"))).toBe(false); // matched by *.env, not skipped as "outside"
  });

  it("builds through a symlinked workspace path (the root is realpath'd)", async () => {
    const real = await makeWorkspace();
    const link = join(await mkdtemp(join(tmpdir(), "fa-wslink-")), "agent");
    await symlink(real, link); // build THROUGH a symlink to the workspace
    const out = await freshOut();
    await buildOk(link, out);
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
    expect(await exists(join(out, "docs", "schema.md"))).toBe(true);
  });

  it("matches ignore rules case-sensitively (a README.md rule does not drop readme.md)", async () => {
    // One file only — a case-insensitive FS (macOS) can't hold both README.md and readme.md.
    const ws = await makeWorkspace({ gitignore: "README.md\n" });
    await writeFile(join(ws, "readme.md"), "lower\n"); // different case than the rule
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "readme.md"))).toBe(true); // rule's case differs → not excluded
  });

  it("honors only the ROOT .gitignore/.fastagentignore (flat) — not nested or ancestor rules", async () => {
    const ws = await makeWorkspace({ gitignore: "*.env\n" }); // ROOT rule
    await writeFile(join(ws, "secret.env"), "S\n");
    await mkdir(join(ws, "sub"), { recursive: true });
    await writeFile(join(ws, "sub", "keep.log"), "k\n");
    await writeFile(join(ws, "sub", ".gitignore"), "keep.log\n"); // NESTED rule — not honored
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "secret.env"))).toBe(false); // root rule applied (any depth)
    expect(await exists(join(out, "sub", "keep.log"))).toBe(true); // nested .gitignore NOT honored
  });

  it("does not read ancestor .gitignore outside a repo (reproducible, install-independent)", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fa-noancestor-"));
    await writeFile(join(parent, ".gitignore"), "AGENTS.md\n"); // a stray ancestor rule, NO .git anywhere
    const solo = join(parent, "agent");
    await mkdir(solo, { recursive: true });
    await writeFile(join(solo, "AGENTS.md"), "# Bot\n");
    await writeFile(join(solo, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    const out = await freshOut();
    await buildOk(solo, out);
    expect(await exists(join(out, "AGENTS.md"))).toBe(true); // ancestor .gitignore not honored (no repo root)
  });

  it("honors .gitignore in any tree; .git/ and node_modules/ are hard-excluded", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws, ".gitignore"), "scratch/\n");
    await mkdir(join(ws, "scratch"), { recursive: true });
    await writeFile(join(ws, "scratch", "note.md"), "scratch\n");
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "scratch"))).toBe(false); // .gitignore'd → not shipped
    expect(await exists(join(out, ".git"))).toBe(false); // hard-excluded
    expect(await exists(join(out, "node_modules"))).toBe(false); // hard-excluded
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
    expect(await exists(join(out, "docs", "schema.md"))).toBe(true);
  });

  it("is non-destructive to the source tree", async () => {
    const ws = await makeWorkspace();
    const out = await freshOut();
    await buildOk(ws, out);
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
      await buildOk(ws, off);
      expect((await readdir(join(off, "skills"))).sort()).toEqual(["local-skill"]); // default: definition-only

      const on = await freshOut();
      await buildOk(ws, on, { globalSkills: true });
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
      await buildOk(ws, out, { globalSkills: true });
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

  it("skips symlink entries (not followed, not shipped) so the artifact is self-contained", async () => {
    const shared = await mkdtemp(join(tmpdir(), "fa-shared-"));
    await writeFile(join(shared, "schema.md"), "# shared\n");
    const ws = await makeWorkspace();
    await rm(join(ws, "docs"), { recursive: true });
    await symlink(shared, join(ws, "docs")); // a symlinked directory
    await symlink(join(shared, "schema.md"), join(ws, "link.md")); // a symlinked file
    await symlink("node_modules", join(ws, "vendor")); // a symlink aliasing a hard-excluded tree
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "docs"))).toBe(false); // symlinked dir not followed
    expect(await exists(join(out, "link.md"))).toBe(false); // file symlink not shipped
    expect(await exists(join(out, "vendor"))).toBe(false); // symlink to node_modules not smuggled in
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
  });

  it("fails visibly when AGENTS.md is excluded from the artifact (authored context)", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws, ".fastagentignore"), "AGENTS.md\n");
    const out = await freshOut();
    await expect(buildOk(ws, out)).rejects.toThrow(/AGENTS\.md is excluded/);
  });

  it("a workspace ignore does not exclude a loaded skill; the skill's OWN ignore governs its files", async () => {
    // Fork A: .gitignore/.fastagentignore govern AUTHORED context, not the skill set. A skill
    // ships its own dir minus its OWN nested ignores; to drop a skill, remove it.
    const ws = await makeWorkspace();
    await mkdir(join(ws, "skills", "secret"), { recursive: true });
    await writeFile(join(ws, "skills", "secret", "SKILL.md"), "---\nname: secret\ndescription: x.\n---\nb\n");
    await writeFile(join(ws, "skills", "secret", "junk.log"), "noise\n");
    await writeFile(join(ws, "skills", "secret", ".gitignore"), "junk.log\n"); // the skill's OWN ignore
    await writeFile(join(ws, ".fastagentignore"), "skills/secret/\n"); // workspace rule: does NOT apply to skills
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "skills", "secret", "SKILL.md"))).toBe(true); // skill still ships
    expect(await exists(join(out, "skills", "secret", "junk.log"))).toBe(false); // own ignore honored
  });

  it("recognizes an in-tree out even when src and out are spelled through different symlinks", async () => {
    const real = await mkdtemp(join(tmpdir(), "fa-build-real-"));
    await writeFile(join(real, "AGENTS.md"), "# Bot\n");
    await writeFile(join(real, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    const link = join(await mkdtemp(join(tmpdir(), "fa-build-link-")), "ws");
    await symlink(real, link); // src reached via a symlink alias
    const out = join(real, ".fastagent", "build"); // in-tree out (under .fastagent/), via the real path
    await buildOk(link, out); // must not descend into the artifact it creates
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
    expect(await exists(join(out, ".fastagent"))).toBe(false); // no nested .fastagent recursion
  });

  it("fails visibly on an unreadable .fastagentignore (only ENOENT is normal)", async () => {
    const ws = await makeWorkspace();
    await mkdir(join(ws, ".fastagentignore")); // a directory where a file is expected → read fails (not ENOENT)
    const out = await freshOut();
    await expect(buildOk(ws, out)).rejects.toThrow(/cannot read .*\.fastagentignore/);
  });

  it("model precedence: --model option beats config; bad/missing model fails before writing", async () => {
    const ws = await makeWorkspace({ config: `export default { model: "openai-codex/gpt-5.5" };` });
    const out = await freshOut();
    const { manifest } = await buildOk(ws, out, { model: "openai-codex/gpt-5.4" });
    expect(manifest.model).toBe("openai-codex/gpt-5.4");

    const bad = await freshOut();
    await expect(buildOk(ws, bad, { model: "nope/nothing" })).rejects.toThrow(/unknown model/);
    expect(await exists(join(bad, "fastagent.json"))).toBe(false);
  });

  it("rejects an output that is, or contains, the source (cannot publish over the input)", async () => {
    const ws = await makeWorkspace();
    await expect(buildOk(ws, ws)).rejects.toThrow(/must differ from the source/);
    await expect(buildOk(ws, join(ws, ".."))).rejects.toThrow(/must not contain the source/);
    // a symlink whose target is the source is caught by realpath
    const link = join(await mkdtemp(join(tmpdir(), "fa-link-")), "out");
    await symlink(ws, link);
    await expect(buildOk(ws, link)).rejects.toThrow(/must differ from the source/);
    expect(await exists(join(ws, "AGENTS.md"))).toBe(true); // source intact throughout
  });

  it("rejects a root entry named fastagent.json including a DIRECTORY (clear error, not EISDIR)", async () => {
    const ws = await makeWorkspace();
    await mkdir(join(ws, "fastagent.json"), { recursive: true });
    await writeFile(join(ws, "fastagent.json", "inner.txt"), "x\n");
    await expect(buildOk(ws, await freshOut())).rejects.toThrow(/reserved for the build manifest/);
  });

  it("skips a SYMLINKED skills/ in the authored pass; skills come only from the model", async () => {
    // A symlinked skills/ must not be copied in as a raw tree (which would carry collision
    // losers); the authored-context walk skips it by realpath, model materialization fills it.
    const shared = await mkdtemp(join(tmpdir(), "fa-shared-skills-"));
    await mkdir(join(shared, "aaa"), { recursive: true });
    await mkdir(join(shared, "zzz"), { recursive: true });
    await writeFile(join(shared, "aaa", "SKILL.md"), "---\nname: dup\ndescription: a\n---\nA\n");
    await writeFile(join(shared, "zzz", "SKILL.md"), "---\nname: dup\ndescription: z\n---\nZ\n"); // same name
    const ws = await mkdtemp(join(tmpdir(), "fa-symskills-ws-"));
    await writeFile(join(ws, "AGENTS.md"), "# Bot\n");
    await writeFile(join(ws, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };`);
    await symlink(shared, join(ws, "skills")); // skills/ is a symlink to the shared tree
    const out = await freshOut();
    await buildOk(ws, out);
    expect((await readdir(join(out, "skills"))).sort()).toEqual(["dup"]); // only the winner, no aaa/zzz
  });

  it("materializes only the winner of a local name collision (by name), never the loser", async () => {
    const ws = await makeWorkspace(); // has skills/local-skill (name local-skill)
    // two more local skills declaring the SAME name: one wins, one loses
    await mkdir(join(ws, "skills", "aaa"), { recursive: true });
    await mkdir(join(ws, "skills", "zzz"), { recursive: true });
    await writeFile(join(ws, "skills", "aaa", "SKILL.md"), "---\nname: dup\ndescription: a\n---\nA\n");
    await writeFile(join(ws, "skills", "zzz", "SKILL.md"), "---\nname: dup\ndescription: z\n---\nZ\n");
    const out = await freshOut();
    await buildOk(ws, out);
    const dirs = (await readdir(join(out, "skills"))).sort();
    expect(dirs).toEqual(["dup", "local-skill"]); // produced BY NAME from the model; no aaa/zzz dirs
    // the artifact reloads with no duplicate — exactly one "dup" skill, no collision
    const reloaded = await loadAgentDefinition(out, { skillPaths: [] });
    expect(reloaded.skills.filter((s) => s.name === "dup")).toHaveLength(1);
    expect(reloaded.collisions).toEqual([]);
  });

  it("self-gitignores the in-tree .fastagent state dir (parity with the dev path)", async () => {
    const ws = await makeWorkspace();
    await buildOk(ws, join(ws, ".fastagent", "build")); // in-tree default
    expect(await readFile(join(ws, ".fastagent", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("rebuild replaces the artifact via move-aside, leaving no staging/backup litter", async () => {
    const ws = await makeWorkspace();
    const out = join(ws, ".fastagent", "build"); // in-tree → staging + backup live under .fastagent
    await buildOk(ws, out);
    await writeFile(join(ws, "AGENTS.md"), "# Build Bot v2\n");
    await buildOk(ws, out); // rebuild over the existing artifact
    expect(await readFile(join(out, "AGENTS.md"), "utf8")).toContain("v2"); // new content installed
    // the old artifact was moved aside then dropped — no .fa-build-*/.fa-old-* left behind
    const leftovers = (await readdir(join(ws, ".fastagent"))).filter((n) => n.startsWith(".fa-"));
    expect(leftovers).toEqual([]);
  });

  it("in-tree staging lives under .fastagent so a crash-orphaned staging never ships", async () => {
    const ws = await makeWorkspace();
    // simulate a staging dir orphaned by a prior crashed build, where the code now puts it
    await mkdir(join(ws, ".fastagent", ".fa-build-STALE"), { recursive: true });
    await writeFile(join(ws, ".fastagent", ".fa-build-STALE", "junk.txt"), "partial\n");
    const out = join(ws, ".fastagent", "build"); // in-tree out (must be under .fastagent/)
    await buildOk(ws, out);
    expect(await exists(join(out, ".fastagent"))).toBe(false); // .fastagent (and its staging) never walked
    expect(await exists(join(out, ".fa-build-STALE"))).toBe(false);
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
  });

  it("rejects an in-tree --out outside .fastagent/ (authored content), leaving the source intact", async () => {
    const ws = await makeWorkspace(); // has authored docs/schema.md
    await expect(buildOk(ws, join(ws, "docs"))).rejects.toThrow(/in-tree build output must be under \.fastagent/);
    expect(await exists(join(ws, "docs", "schema.md"))).toBe(true); // authored content untouched
  });

  it("publishes through a symlinked --out to its real target, preserving the symlink", async () => {
    const ws = await makeWorkspace();
    const deploy = join(await mkdtemp(join(tmpdir(), "fa-deploy-")), "deploy");
    await mkdir(deploy, { recursive: true });
    await writeFile(join(deploy, "stale.txt"), "old\n");
    await symlink(deploy, join(ws, "publish")); // in-workspace symlink → out-of-tree deploy dir
    await buildPiArtifact(ws, join(ws, "publish"), { force: true });
    // the artifact lands in the real target; the symlink is preserved (source not mutated)
    expect((await lstat(join(ws, "publish"))).isSymbolicLink()).toBe(true);
    expect(await exists(join(deploy, "fastagent.json"))).toBe(true);
    expect(await exists(join(deploy, "stale.txt"))).toBe(false); // replaced wholesale
    expect(await exists(join(ws, "publish", "AGENTS.md"))).toBe(true); // reachable via the symlink
  });

  it("rejects a nonexistent source workspace without creating it (no empty artifact)", async () => {
    const base = await mkdtemp(join(tmpdir(), "fa-nosrc-"));
    const typo = join(base, "typo"); // does not exist
    await expect(
      buildPiArtifact(typo, await freshOut(), { model: "openai-codex/gpt-5.5", force: true }),
    ).rejects.toThrow(/does not exist/);
    expect(await exists(typo)).toBe(false); // the typo'd dir was NOT conjured by mkdir
  });

  it("guards an --out OUTSIDE the source tree behind force (avoids nuking unrelated dirs)", async () => {
    const ws = await makeWorkspace();
    const outside = await freshOut(); // a sibling temp dir, outside ws
    await expect(buildPiArtifact(ws, outside)).rejects.toThrow(/outside the source workspace/);
    await buildPiArtifact(ws, outside, { force: true }); // explicit confirmation builds
    expect(await exists(join(outside, "fastagent.json"))).toBe(true);
    // a target INSIDE the source tree needs no force (the real default, .fastagent/build)
    await buildPiArtifact(ws, join(ws, ".fastagent", "build"));
    expect(await exists(join(ws, ".fastagent", "build", "fastagent.json"))).toBe(true);
  });

  it("replaces an existing target atomically; a rebuild reflects the current source (no stale)", async () => {
    const ws = await makeWorkspace();
    const out = await freshOut();
    // a pre-existing unrelated file at the target is replaced — the target is regenerable output
    await writeFile(join(out, "stale.txt"), "old\n");
    await buildOk(ws, out);
    expect(await exists(join(out, "stale.txt"))).toBe(false); // replaced wholesale by the publish
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
    // rebuild after dropping a skill from the source: the artifact is the truth
    await rm(join(ws, "skills", "local-skill"), { recursive: true, force: true });
    await buildOk(ws, out);
    expect(await exists(join(out, "skills", "local-skill"))).toBe(false);
    expect(await exists(join(out, "fastagent.json"))).toBe(true);
  });

  it("fails visibly when the source ships a root fastagent.json (reserved manifest name)", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws, "fastagent.json"), `{"authored":"runtime params the agent reads"}\n`);
    await expect(buildOk(ws, await freshOut())).rejects.toThrow(/reserved for the build manifest/);
    expect(await readFile(join(ws, "fastagent.json"), "utf8")).toContain("authored"); // source intact
  });

  it("allows a root fastagent.json that is ignored (it would not ship, so it cannot collide)", async () => {
    const ws = await makeWorkspace({ gitignore: "fastagent.json\n" });
    await writeFile(join(ws, "fastagent.json"), `{"generated":true}\n`);
    const out = await freshOut();
    await buildOk(ws, out); // not rejected: the ignored source file never reaches the artifact
    expect(JSON.parse(await readFile(join(out, "fastagent.json"), "utf8")).engine).toBe("pi"); // the manifest
  });

  it(".fastagentignore is authoritative over .gitignore at the root (applied last)", async () => {
    const ws = await makeWorkspace({ gitignore: "*.env\n" }); // git excludes all .env
    await writeFile(join(ws, "wanted.env"), "W\n");
    await writeFile(join(ws, ".fastagentignore"), "!wanted.env\n"); // fa re-includes — wins (last)
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "wanted.env"))).toBe(true); // .fastagentignore overrides .gitignore
  });

  it("rejects a reserved root fastagent.json BEFORE bundling, so a rebuild keeps the prior artifact", async () => {
    const ws = await makeWorkspace();
    const out = await freshOut();
    await buildOk(ws, out); // a good prior artifact
    const readEngine = async () => JSON.parse(await readFile(join(out, "fastagent.json"), "utf8")).engine;
    expect(await readEngine()).toBe("pi");
    // source now accidentally ships a root fastagent.json; rebuild into the same out
    await writeFile(join(ws, "fastagent.json"), `{"oops":1}\n`);
    await expect(buildOk(ws, out)).rejects.toThrow(/reserved for the build manifest/);
    // the destructive bundle never ran: the prior artifact's manifest survives, out not poisoned
    expect(await readEngine()).toBe("pi");
  });

  it("builds an agent whose local skill dir is a symlink (validation uses the real ship-set)", async () => {
    // A symlinked skill dir is dereferenced by the walk; the single ship-plan includes the
    // SKILL.md, so validation passes instead of aborting as "definition file excluded".
    const ext = await mkdtemp(join(tmpdir(), "fa-ext-skill-"));
    await writeFile(join(ext, "SKILL.md"), "---\nname: linked\ndescription: d\n---\nbody\n");
    const ws = await makeWorkspace();
    await symlink(ext, join(ws, "skills", "linked"));
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "skills", "linked", "SKILL.md"))).toBe(true);
  });

  it("honors .gitignore without invoking git (reproducible, install-independent)", async () => {
    // The build reads .gitignore itself (via the ignore library); no git binary is called,
    // so the result is the same with or without git installed.
    const ws = await makeWorkspace({ gitignore: "ignored.txt\n" });
    await writeFile(join(ws, "ignored.txt"), "excluded by .gitignore\n");
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "ignored.txt"))).toBe(false); // .gitignore honored, no git
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
  });

  it("builds into the default in-tree out (.fastagent/build) without copying it into itself", async () => {
    const ws = await makeWorkspace();
    const out = join(ws, ".fastagent", "build"); // the CLI default — inside the source tree
    await buildOk(ws, out);
    expect(await readFile(join(out, "AGENTS.md"), "utf8")).toContain("Build Bot");
    expect(await exists(join(out, "docs", "schema.md"))).toBe(true);
    // the artifact must not contain a nested copy of itself / .fastagent
    expect(await exists(join(out, ".fastagent"))).toBe(false);
  });

  it("deterministic rebuild: a file dropped from the source does not survive in the artifact", async () => {
    const ws = await makeWorkspace();
    const out = await freshOut();
    await buildOk(ws, out);
    expect(await exists(join(out, "docs", "schema.md"))).toBe(true);

    await rm(join(ws, "docs"), { recursive: true });
    await buildOk(ws, out);
    expect(await exists(join(out, "docs"))).toBe(false); // stale authored context gone
    expect(await exists(join(out, "AGENTS.md"))).toBe(true);
  });
});
