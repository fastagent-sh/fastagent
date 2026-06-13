import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArtifact, loadAgentDefinition, type ArtifactManifest } from "../src/index.ts";

/** A throwaway workspace: AGENTS.md + one definition-local skill (+ optional config). */
async function makeWorkspace(opts: { config?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-build-ws-"));
  await writeFile(join(dir, "AGENTS.md"), "# Build Bot\nBe terse.\n");
  await mkdir(join(dir, "skills", "local-skill"), { recursive: true });
  await writeFile(
    join(dir, "skills", "local-skill", "SKILL.md"),
    "---\nname: local-skill\ndescription: A local skill.\n---\nLocal body.\n",
  );
  if (opts.config !== undefined) await writeFile(join(dir, "fastagent.config.mjs"), opts.config);
  return dir;
}

describe("build: buildPiArtifact", () => {
  it("materializes AGENTS.md + skills + a manifest with the resolved model", async () => {
    const ws = await makeWorkspace({ config: `export default { model: "openai-codex/gpt-5.5", http: { port: 9000 } };` });
    const out = await mkdtemp(join(tmpdir(), "fa-build-out-"));
    const { manifest } = await buildPiArtifact(ws, out);

    expect(await readFile(join(out, "AGENTS.md"), "utf8")).toContain("Build Bot");
    expect((await readdir(join(out, "skills"))).sort()).toEqual(["local-skill"]);

    const onDisk = JSON.parse(await readFile(join(out, "fastagent.json"), "utf8")) as ArtifactManifest;
    expect(onDisk).toEqual(manifest);
    expect(onDisk.engine).toBe("pi");
    expect(onDisk.model).toBe("openai-codex/gpt-5.5"); // from config
    expect(onDisk.http).toEqual({ port: 9000 }); // carried from config.http
    expect(typeof onDisk.builtAt).toBe("string");
    expect(onDisk.fastagentVersion).toMatch(/^\d+\.\d+\.\d+/);
    // tools are functions, not serializable — the manifest must not carry them
    expect(onDisk).not.toHaveProperty("tools");
  });

  it("the built artifact reloads as a definition-only agent (self-contained)", async () => {
    const ws = await makeWorkspace();
    const out = await mkdtemp(join(tmpdir(), "fa-build-out-"));
    await buildPiArtifact(ws, out, { model: "openai-codex/gpt-5.5" });
    const reloaded = await loadAgentDefinition(out, { skillPaths: [] });
    expect(reloaded.instructions).toContain("Build Bot");
    expect(reloaded.skills.map((s) => s.name)).toEqual(["local-skill"]);
  });

  it("model precedence: --model option beats config", async () => {
    const ws = await makeWorkspace({ config: `export default { model: "openai-codex/gpt-5.5" };` });
    const out = await mkdtemp(join(tmpdir(), "fa-build-out-"));
    const { manifest } = await buildPiArtifact(ws, out, { model: "openai-codex/gpt-5.4" });
    expect(manifest.model).toBe("openai-codex/gpt-5.4");
  });

  it("missing model throws a clear error (fail visibly)", async () => {
    const ws = await makeWorkspace(); // no config, no model option
    const out = await mkdtemp(join(tmpdir(), "fa-build-out-"));
    const saved = process.env.FASTAGENT_MODEL;
    delete process.env.FASTAGENT_MODEL;
    try {
      await expect(buildPiArtifact(ws, out)).rejects.toThrow(/missing model/);
    } finally {
      if (saved !== undefined) process.env.FASTAGENT_MODEL = saved;
    }
  });

  it("globalSkills materializes the machine's global skills into the artifact", async () => {
    const home = await mkdtemp(join(tmpdir(), "fa-home-"));
    await mkdir(join(home, ".pi", "agent", "skills", "global-skill"), { recursive: true });
    await writeFile(
      join(home, ".pi", "agent", "skills", "global-skill", "SKILL.md"),
      "---\nname: global-skill\ndescription: A global skill.\n---\nGlobal body.\n",
    );
    const ws = await makeWorkspace();
    const out = await mkdtemp(join(tmpdir(), "fa-build-out-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const off = await buildPiArtifact(ws, out, { model: "openai-codex/gpt-5.5" });
      expect(off.definition.skills.map((s) => s.name).sort()).toEqual(["local-skill"]); // definition-only default
      const on = await buildPiArtifact(ws, out, { model: "openai-codex/gpt-5.5", globalSkills: true });
      expect(on.definition.skills.map((s) => s.name).sort()).toEqual(["global-skill", "local-skill"]);
      expect((await readdir(join(out, "skills"))).sort()).toEqual(["global-skill", "local-skill"]);
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
      else delete process.env.HOME;
    }
  });

  it("deterministic rebuild: a skill dropped from the workspace does not survive in the artifact", async () => {
    const ws = await makeWorkspace({ config: `export default { model: "openai-codex/gpt-5.5" };` });
    await mkdir(join(ws, "skills", "extra"), { recursive: true });
    await writeFile(join(ws, "skills", "extra", "SKILL.md"), "---\nname: extra\ndescription: Extra.\n---\nx\n");
    const out = await mkdtemp(join(tmpdir(), "fa-build-out-"));

    await buildPiArtifact(ws, out);
    expect((await readdir(join(out, "skills"))).sort()).toEqual(["extra", "local-skill"]);

    await rm(join(ws, "skills", "extra"), { recursive: true });
    await buildPiArtifact(ws, out);
    expect((await readdir(join(out, "skills"))).sort()).toEqual(["local-skill"]); // stale skill gone
  });
});
