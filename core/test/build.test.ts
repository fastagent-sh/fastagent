import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiWorkspace, type BuildManifest } from "../src/index.ts";

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** A throwaway workspace: AGENTS.md + a definition-local skill + root-level authored context. */
async function makeWorkspace(opts: { config?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-build-ws-"));
  await writeFile(join(dir, "AGENTS.md"), "# Build Bot\nWhen asked about the schema, read docs/schema.md.\n");
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "schema.md"), "# Schema\nusers(id, name)\n");
  await mkdir(join(dir, "skills", "local-skill"), { recursive: true });
  await writeFile(
    join(dir, "skills", "local-skill", "SKILL.md"),
    "---\nname: local-skill\ndescription: A local skill.\n---\nLocal body.\n",
  );
  if (opts.config !== undefined) await writeFile(join(dir, "fastagent.config.mjs"), opts.config);
  return dir;
}

const manifestPath = (dir: string) => join(dir, ".fastagent", "manifest.json");

describe("build: buildPiWorkspace", () => {
  it("writes a manifest with the resolved model + http, and self-gitignores .fastagent", async () => {
    const ws = await makeWorkspace({ config: `export default { model: "openai-codex/gpt-5.5", http: { port: 9000 } };` });
    const { manifest } = await buildPiWorkspace(ws);

    const onDisk = JSON.parse(await readFile(manifestPath(ws), "utf8")) as BuildManifest;
    expect(onDisk).toEqual(manifest);
    expect(onDisk.engine).toBe("pi");
    expect(onDisk.model).toBe("openai-codex/gpt-5.5"); // from config
    expect(onDisk.http).toEqual({ port: 9000 });
    expect(typeof onDisk.builtAt).toBe("string");
    expect(onDisk.fastagentVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(onDisk).not.toHaveProperty("tools"); // functions are not serializable

    expect(await readFile(join(ws, ".fastagent", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("is non-destructive: leaves the source tree (incl. authored context) intact", async () => {
    const ws = await makeWorkspace({ config: `export default { model: "openai-codex/gpt-5.5" };` });
    await buildPiWorkspace(ws);
    // build validates + writes a manifest; it must not strip or move the project.
    // Authored context (docs/schema.md) therefore ships because nothing is removed.
    expect(await exists(join(ws, "AGENTS.md"))).toBe(true);
    expect(await exists(join(ws, "skills", "local-skill", "SKILL.md"))).toBe(true);
    expect(await exists(join(ws, "docs", "schema.md"))).toBe(true);
    expect(await readFile(join(ws, "docs", "schema.md"), "utf8")).toContain("users(id, name)");
  });

  it("model precedence: --model option beats config", async () => {
    const ws = await makeWorkspace({ config: `export default { model: "openai-codex/gpt-5.5" };` });
    const { manifest } = await buildPiWorkspace(ws, { model: "openai-codex/gpt-5.4" });
    expect(manifest.model).toBe("openai-codex/gpt-5.4");
  });

  it("missing model throws a clear error and writes no manifest (fail visibly)", async () => {
    const ws = await makeWorkspace(); // no config, no model option
    const saved = process.env.FASTAGENT_MODEL;
    delete process.env.FASTAGENT_MODEL;
    try {
      await expect(buildPiWorkspace(ws)).rejects.toThrow(/missing model/);
      expect(await exists(manifestPath(ws))).toBe(false);
    } finally {
      if (saved !== undefined) process.env.FASTAGENT_MODEL = saved;
    }
  });

  it("rejects an unknown/malformed model before writing the manifest", async () => {
    const ws = await makeWorkspace();
    await expect(buildPiWorkspace(ws, { model: "nope/nothing" })).rejects.toThrow(/unknown model/);
    await expect(buildPiWorkspace(ws, { model: "justmodel" })).rejects.toThrow(/provider\/modelId/);
    expect(await exists(manifestPath(ws))).toBe(false);
  });
});
