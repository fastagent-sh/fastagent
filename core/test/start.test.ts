import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArtifact, createPiAgentFromArtifact, loadManifest } from "../src/index.ts";

/** A minimal workspace, then build it into an artifact — the input `start` consumes. */
async function makeArtifact(opts: { config?: string } = {}): Promise<{ artifact: string }> {
  const ws = await mkdtemp(join(tmpdir(), "fa-start-ws-"));
  await writeFile(join(ws, "AGENTS.md"), "# Start Bot\n");
  await mkdir(join(ws, "skills", "s1"), { recursive: true });
  await writeFile(join(ws, "skills", "s1", "SKILL.md"), "---\nname: s1\ndescription: A skill.\n---\nBody.\n");
  await writeFile(
    join(ws, "fastagent.config.mjs"),
    opts.config ?? `export default { model: "openai-codex/gpt-5.5", http: { port: 9100 } };`,
  );
  const artifact = await mkdtemp(join(tmpdir(), "fa-start-art-"));
  await buildPiArtifact(ws, artifact, { force: true });
  return { artifact };
}

const freshSessions = () => mkdtemp(join(tmpdir(), "fa-start-sess-"));

describe("start: loadManifest", () => {
  it("reads the manifest a build wrote", async () => {
    const { artifact } = await makeArtifact();
    const m = await loadManifest(artifact);
    expect(m.engine).toBe("pi");
    expect(m.model).toBe("openai-codex/gpt-5.5");
    expect(m.http).toEqual({ port: 9100 });
  });

  it("fails visibly when the dir is not a built artifact (no fastagent.json)", async () => {
    const empty = await mkdtemp(join(tmpdir(), "fa-start-empty-"));
    await expect(loadManifest(empty)).rejects.toThrow(/not a built artifact .*fastagent build/);
  });

  it("rejects a corrupt manifest, a non-pi engine, and a missing model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-start-bad-"));
    await writeFile(join(dir, "fastagent.json"), "{ not json");
    await expect(loadManifest(dir)).rejects.toThrow(/invalid JSON/);

    await writeFile(join(dir, "fastagent.json"), JSON.stringify({ engine: "claude", model: "x/y" }));
    await expect(loadManifest(dir)).rejects.toThrow(/engine "claude" is not runnable/);

    await writeFile(join(dir, "fastagent.json"), JSON.stringify({ engine: "pi" }));
    await expect(loadManifest(dir)).rejects.toThrow(/"model" must be a non-empty/);

    await writeFile(join(dir, "fastagent.json"), JSON.stringify({ engine: "pi", model: "x/y", http: { port: 70000 } }));
    await expect(loadManifest(dir)).rejects.toThrow(/http\.port.*0-65535/);
  });
});

describe("start: createPiAgentFromArtifact", () => {
  it("assembles an agent from the artifact: manifest model, definition, external sessions dir", async () => {
    const { artifact } = await makeArtifact();
    const sessionsDir = await freshSessions();
    const { agent, definition, manifest, modelSpec, sessionsDir: used } = await createPiAgentFromArtifact(artifact, {
      sessionsDir,
    });
    expect(typeof agent.invoke).toBe("function");
    expect(modelSpec).toBe("openai-codex/gpt-5.5");
    expect(manifest.engine).toBe("pi");
    expect(definition.instructions).toContain("Start Bot");
    expect(definition.skills.map((s) => s.name)).toEqual(["s1"]);
    expect(used).toBe(sessionsDir);
    // the session dir is self-gitignored so a start inside a repo hides runtime state
    expect(await readFile(join(sessionsDir, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("model precedence: --model option beats the frozen manifest model", async () => {
    const { artifact } = await makeArtifact();
    const { modelSpec } = await createPiAgentFromArtifact(artifact, {
      model: "openai-codex/gpt-5.4",
      sessionsDir: await freshSessions(),
    });
    expect(modelSpec).toBe("openai-codex/gpt-5.4");
  });

  it("FASTAGENT_SESSIONS_DIR is used when no explicit dir is passed", async () => {
    const { artifact } = await makeArtifact();
    const envDir = await freshSessions();
    const saved = process.env.FASTAGENT_SESSIONS_DIR;
    process.env.FASTAGENT_SESSIONS_DIR = envDir;
    try {
      const { sessionsDir } = await createPiAgentFromArtifact(artifact, {});
      expect(sessionsDir).toBe(envDir);
    } finally {
      if (saved !== undefined) process.env.FASTAGENT_SESSIONS_DIR = saved;
      else delete process.env.FASTAGENT_SESSIONS_DIR;
    }
  });

  it("fails visibly on a bad --model spec (validated against the registry)", async () => {
    const { artifact } = await makeArtifact();
    await expect(
      createPiAgentFromArtifact(artifact, { model: "nope/nothing", sessionsDir: await freshSessions() }),
    ).rejects.toThrow(/unknown model/);
  });

  it("runs definition-only: a global skill on the machine is never loaded", async () => {
    const home = await mkdtemp(join(tmpdir(), "fa-start-home-"));
    await mkdir(join(home, ".pi", "agent", "skills", "global-skill"), { recursive: true });
    await writeFile(
      join(home, ".pi", "agent", "skills", "global-skill", "SKILL.md"),
      "---\nname: global-skill\ndescription: A global skill.\n---\nGlobal.\n",
    );
    const { artifact } = await makeArtifact();
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const { definition } = await createPiAgentFromArtifact(artifact, { sessionsDir: await freshSessions() });
      expect(definition.skills.map((s) => s.name)).toEqual(["s1"]); // artifact is the truth, never global
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
      else delete process.env.HOME;
    }
  });

  it("appends code tools shipped in the artifact's config", async () => {
    // A config.ts so loadConfig accepts a single config file; the tool must survive into the agent.
    const ws = await mkdtemp(join(tmpdir(), "fa-start-tools-ws-"));
    await writeFile(join(ws, "AGENTS.md"), "# Bot\n");
    await writeFile(
      join(ws, "fastagent.config.ts"),
      `export default { model: "openai-codex/gpt-5.5", tools: [{ name: "ping", description: "d", parameters: {}, execute: async () => "pong" }] };\n`,
    );
    const artifact = await mkdtemp(join(tmpdir(), "fa-start-tools-art-"));
    await buildPiArtifact(ws, artifact, { force: true });
    const { config } = await createPiAgentFromArtifact(artifact, { sessionsDir: await freshSessions() });
    expect(config.tools?.map((t) => t.name)).toEqual(["ping"]);
  });
});
