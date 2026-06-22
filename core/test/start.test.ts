import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPiArtifact, createPiAgentFromArtifact, loadManifest } from "../src/index.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Run the CLI to completion (for paths that exit, e.g. an invalid argument). */
function cliRunToExit(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

/** Run the CLI until it logs the http-channel line; return the bound port, then kill it. */
function cliBoundPort(args: string[], env: NodeJS.ProcessEnv = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout before binding; stderr:\n${stderr}`));
    }, 8000);
    child.stderr.on("data", (d) => {
      stderr += String(d);
      const m = stderr.match(/http channel on :(\d+)/);
      if (m) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve(Number(m[1]));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited (code ${code}) before binding; stderr:\n${stderr}`));
    });
  });
}

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
    const {
      agent,
      definition,
      manifest,
      modelSpec,
      sessionsDir: used,
    } = await createPiAgentFromArtifact(artifact, {
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

  it("empty PORT env falls through to the manifest port (not listen(0))", async () => {
    // The bug: Number("") === 0, so `PORT=` (empty) used to bind an ephemeral port. A random
    // manifest port proves fall-through: the bound port can only match it if `PORT=` was
    // treated as unset (no --port given, so the manifest is the next source).
    const manifestPort = 19000 + Math.floor(Math.random() * 10000);
    const ws = await mkdtemp(join(tmpdir(), "fa-start-port-ws-"));
    await writeFile(join(ws, "AGENTS.md"), "# Bot\n");
    await writeFile(
      join(ws, "fastagent.config.mjs"),
      `export default { model: "openai-codex/gpt-5.5", http: { port: ${manifestPort} } };`,
    );
    const artifact = await mkdtemp(join(tmpdir(), "fa-start-port-art-"));
    await buildPiArtifact(ws, artifact, { force: true });
    const bound = await cliBoundPort(["start", artifact, "--sessions-dir", await freshSessions()], { PORT: "" });
    expect(bound).toBe(manifestPort);
  });

  it("rejects a non-decimal port (strict parse, not Number coercion) with a clean exit", async () => {
    const { artifact } = await makeArtifact();
    const { code, stderr } = await cliRunToExit([
      "start",
      artifact,
      "--port",
      "0x50",
      "--sessions-dir",
      await freshSessions(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/invalid --port "0x50": must be an integer 0-65535/);
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
