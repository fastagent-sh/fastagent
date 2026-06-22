import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FileError, err } from "@earendil-works/pi-agent-core";
import {
  collect,
  createPiAgentFromDefinition,
  defaultGlobalSkillPaths,
  loadAgentDefinition,
  piBasePrompt,
  piDefaultTools,
  type CreatePiAgentFromDefinitionOptions,
} from "../src/index.ts";
// bundleAgentDefinition is internal (not re-exported): import it from its module.
import { bundleAgentDefinition } from "../src/engines/pi/definition.ts";
import { assembleSystemPrompt } from "../src/engines/pi/create.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agent");
const extraSkillsDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "extra-skills");

describe("definition: loadAgentDefinition", () => {
  it("loads instructions from AGENTS.md and skills from SKILL.md frontmatter", async () => {
    const def = await loadAgentDefinition(fixtureDir, { skillPaths: [] });
    expect(def.instructions).toContain("Haiku Bot");
    expect(def.instructions).toContain("5-7-5");
    expect(def.dir).toBe(fixtureDir); // AGENTS.md path is derivable: join(dir, "AGENTS.md")
    expect(def.skills).toHaveLength(1);
    expect(def.skills[0]!.name).toBe("season-words");
    expect(def.skills[0]!.description).toContain("kigo");
    expect(def.diagnostics).toHaveLength(0);
  });

  it("missing AGENTS.md / skills returns undefined instructions and empty skills without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-empty-definition-"));
    const def = await loadAgentDefinition(dir, { skillPaths: [] });
    expect(def.instructions).toBeUndefined();
    expect(def.skills).toEqual([]);
  });

  it("AGENTS.md read errors other than not_found throw instead of silently becoming missing instructions", async () => {
    class DeniedEnv extends NodeExecutionEnv {
      override async readTextFile(path: string) {
        if (path.endsWith("AGENTS.md")) {
          return err<string, FileError>(new FileError("permission_denied", "permission denied", path));
        }
        return super.readTextFile(path);
      }
    }
    const env = new DeniedEnv({ cwd: fixtureDir });
    await expect(loadAgentDefinition(fixtureDir, { env, skillPaths: [] })).rejects.toThrow(
      /cannot read .*AGENTS\.md.*permission denied/,
    );
  });

  it("defaultGlobalSkillPaths() returns the machine global dirs (opt-in helper, not the default): ~/.pi/agent/skills + ~/.agents/skills", () => {
    const paths = defaultGlobalSkillPaths();
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/\.pi\/agent\/skills$/);
    expect(paths[1]).toMatch(/\.agents\/skills$/);
  });

  it("defaults to definition-only when skillPaths is omitted (globals are opt-in, not ambient)", async () => {
    // No skillPaths → must NOT scan the machine's global skills; only the folder's own.
    const def = await loadAgentDefinition(fixtureDir);
    expect(def.skills.map((s) => s.name)).toEqual(["season-words"]);
    expect(def.collisions).toEqual([]);
  });

  it("extra skillPaths mount new skills; definition-local skill wins name collisions and surfaces collision info", async () => {
    const def = await loadAgentDefinition(fixtureDir, { skillPaths: [extraSkillsDir] });
    const names = def.skills.map((s) => s.name).sort();
    expect(names).toEqual(["cutting-words", "season-words"]); // the extra one is in, no duplicates
    // collision: the definition-local season-words wins
    const seasonWords = def.skills.find((s) => s.name === "season-words")!;
    expect(seasonWords.filePath).toContain("fixtures/agent/");
    expect(def.collisions).toHaveLength(1);
    expect(def.collisions[0]).toMatchObject({ name: "season-words" });
    expect(def.collisions[0]!.loserPath).toContain("extra-skills");
  });

  it("skillPaths: [] scans only definition-local skills (deterministic deployment posture)", async () => {
    const def = await loadAgentDefinition(fixtureDir, { skillPaths: [] });
    expect(def.skills.map((s) => s.name)).toEqual(["season-words"]);
    expect(def.collisions).toEqual([]);
  });
});

describe("create: assembleSystemPrompt (four segments)", () => {
  it("base + <project_instructions> + skills listing + env context", async () => {
    const def = await loadAgentDefinition(fixtureDir, { skillPaths: [] });
    const prompt = assembleSystemPrompt({
      base: piBasePrompt(), // required: base and toolset must agree, no silent default
      instructions: def.instructions,
      instructionsPath: join(fixtureDir, "AGENTS.md"),
      skills: def.skills,
      cwd: "/work",
    });
    // (1) base (inherited from the pi engine)
    expect(prompt).toContain("operating inside pi");
    // (2) instructions injected wrapped (not pasted bare)
    expect(prompt).toContain("<project_instructions");
    expect(prompt).toContain("Haiku Bot");
    // ③ skills listing
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("season-words");
    // ④ env context
    expect(prompt).toContain("Current working directory: /work");
    // order: base before instructions, instructions before skills
    expect(prompt.indexOf("operating inside pi")).toBeLessThan(prompt.indexOf("<project_instructions"));
    expect(prompt.indexOf("</project_context>")).toBeLessThan(prompt.indexOf("<available_skills>"));
  });

  it("base can be overridden; empty instructions/skills blocks are omitted", () => {
    const prompt = assembleSystemPrompt({ base: "CUSTOM BASE" });
    expect(prompt).toContain("CUSTOM BASE");
    expect(prompt).not.toContain("operating inside pi"); // after override the engine base is gone
    expect(prompt).not.toContain("<project_instructions");
    expect(prompt).not.toContain("<available_skills>");
  });

  it("piBasePrompt renders the tool list from actual tools so base and toolset stay aligned", () => {
    const withTools = piBasePrompt({ tools: piDefaultTools(fixtureDir) });
    expect(withTools).toContain("- read:");
    expect(withTools).toContain("- bash:");
    expect(piBasePrompt()).toContain("(none)");
  });
});

describe("create L2: types only promise options the implementation honors", () => {
  it("L2 options do not accept skills/systemPrompt because they come from the definition directory", () => {
    const base: CreatePiAgentFromDefinitionOptions = { model: {} as never };
    expect(base.model).toBeDefined();
    // @ts-expect-error -- skills must come from the definition folder, not the caller
    const withSkills: CreatePiAgentFromDefinitionOptions = { model: {} as never, skills: [] };
    // @ts-expect-error -- systemPrompt is assembled from the definition, not passed in
    const withPrompt: CreatePiAgentFromDefinitionOptions = { model: {} as never, systemPrompt: "x" };
    expect(withSkills).toBeDefined();
    expect(withPrompt).toBeDefined();
  });
});

describe("create: createPiAgentFromDefinition (directory → agent)", () => {
  it("assembled systemPrompt reaches the model; skills are injected as resources; read tool is present by default", async () => {
    let seenSystemPrompt: string | undefined;
    let seenTools: string[] = [];
    const faux = registerFauxProvider();
    faux.setResponses([
      (context) => {
        seenSystemPrompt = context.systemPrompt;
        seenTools = (context.tools ?? []).map((t) => t.name);
        return fauxAssistantMessage("old pond… — haiku-bot");
      },
    ]);

    const { agent, definition } = await createPiAgentFromDefinition(fixtureDir, {
      model: faux.getModel(),
      skillPaths: [], // hermetic: do not scan this dev machine's real globals
    });
    expect(definition.skills).toHaveLength(1);
    expect(definition.diagnostics).toHaveLength(0);

    const { text } = await collect(agent.invoke({ session: "s" }, { text: "write a haiku" }));
    expect(text).toContain("haiku-bot");
    // definition content actually reached the system prompt; base inherited from pi; tool list includes read
    expect(seenSystemPrompt).toContain("Haiku Bot");
    expect(seenSystemPrompt).toContain("season-words");
    expect(seenSystemPrompt).toContain("operating inside pi");
    expect(seenSystemPrompt).toContain("- read:");
    // default = pi core toolset (fidelity); custom code tools = explicit tools: injection, no magic dir
    expect(seenTools.sort()).toEqual(["bash", "edit", "read", "write"]);
  });
});

describe("create: toolset (real pi tools, fidelity)", () => {
  it("piDefaultTools are pi core four tools (same as pi default)", () => {
    expect(
      piDefaultTools(fixtureDir)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["bash", "edit", "read", "write"]);
  });

  it("pi's read tool can read the fixture (same behavior as local pi)", async () => {
    const read = piDefaultTools(fixtureDir).find((t) => t.name === "read")!;
    const r = await read.execute("t1", { path: "AGENTS.md" });
    const text = (r.content[0] as any).text as string;
    expect(text).toContain("Haiku Bot");
  });
});

describe("definition: bundleAgentDefinition (materializes extra mounts into a deployable bundle at build time)", () => {
  it("bundle is self-contained: AGENTS.md plus winning skill directories; losers are excluded", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "fa-bundle-"));
    const def = await bundleAgentDefinition(fixtureDir, outDir, { skillPaths: [extraSkillsDir] });
    expect(def.collisions).toHaveLength(1);

    // AGENTS.md was copied in
    expect(await readFile(join(outDir, "AGENTS.md"), "utf8")).toContain("Haiku Bot");
    // winning skills: definition-local season-words + extra-mounted cutting-words
    const skillDirs = (await readdir(join(outDir, "skills"))).sort();
    expect(skillDirs).toEqual(["cutting-words", "season-words"]);
    // the collision winner is the definition-local version (not the GLOBAL variant)
    const sw = await readFile(join(outDir, "skills", "season-words", "SKILL.md"), "utf8");
    expect(sw).toContain("kigo");
    expect(sw).not.toContain("GLOBAL variant");
    // the bundle can be reloaded directly (self-contained loop; skillPaths: [] for hermeticity)
    const reloaded = await loadAgentDefinition(outDir, { skillPaths: [] });
    expect(reloaded.skills.map((s) => s.name).sort()).toEqual(["cutting-words", "season-words"]);
  });

  it("allows an in-workspace mount whose original tree is .fastagentignore'd (it materializes)", async () => {
    // The mount ships via materialization into outDir/skills/, NOT its original path, so a
    // user may exclude the original tree to avoid a duplicate copy — build must not reject it.
    const src = await mkdtemp(join(tmpdir(), "fa-bundle-src-"));
    await writeFile(join(src, "AGENTS.md"), "# Bot\n");
    await mkdir(join(src, "extras", "foo"), { recursive: true });
    await writeFile(join(src, "extras", "foo", "SKILL.md"), "---\nname: foo\ndescription: d\n---\nbody\n");
    await writeFile(join(src, ".fastagentignore"), "extras/\n"); // exclude the duplicate original
    const out = await mkdtemp(join(tmpdir(), "fa-bundle-out-"));
    await bundleAgentDefinition(src, out, { skillPaths: [join(src, "extras")] }); // must not throw
    expect(
      await access(join(out, "skills", "foo", "SKILL.md")).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(
      await access(join(out, "extras")).then(
        () => true,
        () => false,
      ),
    ).toBe(false); // no duplicate
  });

  it("rejects skills that materialize to the same artifact path (one case-insensitive guard)", async () => {
    const out = () => mkdtemp(join(tmpdir(), "fa-bundle-out-"));
    // (a) names differ only in case — local "foo" + a mounted "Foo" alias on a case-insensitive FS.
    const a = await mkdtemp(join(tmpdir(), "fa-bundle-src-"));
    await writeFile(join(a, "AGENTS.md"), "# Bot\n");
    await mkdir(join(a, "skills", "foo"), { recursive: true });
    await writeFile(join(a, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: d\n---\nb\n");
    const ext = await mkdtemp(join(tmpdir(), "fa-bundle-ext-"));
    await mkdir(join(ext, "Foo"), { recursive: true });
    await writeFile(join(ext, "Foo", "SKILL.md"), "---\nname: Foo\ndescription: d\n---\nb\n");
    await expect(bundleAgentDefinition(a, await out(), { skillPaths: [ext] })).rejects.toThrow(/same artifact path/);

    // (b) a directory skill "foo.md" and a single-file skill "foo" — both target skills/foo.md.
    const b = await mkdtemp(join(tmpdir(), "fa-bundle-src-"));
    await writeFile(join(b, "AGENTS.md"), "# Bot\n");
    await mkdir(join(b, "skills", "dir"), { recursive: true });
    await writeFile(join(b, "skills", "foo.md"), "---\nname: foo\ndescription: d\n---\nb\n");
    await writeFile(join(b, "skills", "dir", "SKILL.md"), "---\nname: foo.md\ndescription: d\n---\nb\n");
    await expect(bundleAgentDefinition(b, await out())).rejects.toThrow(/same artifact path/);
  });

  it("rejects an unsafe skill name used as a path segment (no traversal out of skills/)", async () => {
    const src = await mkdtemp(join(tmpdir(), "fa-bundle-src-"));
    await writeFile(join(src, "AGENTS.md"), "# Bot\n");
    await mkdir(join(src, "skills", "evil"), { recursive: true });
    await writeFile(join(src, "skills", "evil", "SKILL.md"), "---\nname: ../../escaped\ndescription: d\n---\nb\n");
    const out = await mkdtemp(join(tmpdir(), "fa-bundle-out-"));
    await expect(bundleAgentDefinition(src, out)).rejects.toThrow(/not a valid directory name/);
    expect(
      await access(join(out, "..", "escaped")).then(
        () => true,
        () => false,
      ),
    ).toBe(false); // nothing escaped
  });

  it("materializes an in-workspace mount outside skills/ into outDir/skills/ (reported == shipped)", async () => {
    // A skillPaths mount inside the workspace but outside skills/ is NOT placed at
    // outDir/skills/ by the tree copy; it must still be materialized there, or a
    // definition-only reload (scans outDir/skills/) would lose a skill the bundle reported.
    const src = await mkdtemp(join(tmpdir(), "fa-bundle-src-"));
    await writeFile(join(src, "AGENTS.md"), "# Bot\n");
    await mkdir(join(src, "extras", "foo"), { recursive: true });
    await writeFile(join(src, "extras", "foo", "SKILL.md"), "---\nname: foo\ndescription: d\n---\nbody\n");
    const out = await mkdtemp(join(tmpdir(), "fa-bundle-out-"));
    const def = await bundleAgentDefinition(src, out, { skillPaths: [join(src, "extras")] });
    expect(def.skills.map((s) => s.name)).toContain("foo");
    const reloaded = await loadAgentDefinition(out, { skillPaths: [] }); // artifact reloads itself
    expect(reloaded.skills.map((s) => s.name)).toContain("foo");
  });

  it("materializes every skill by NAME, so a local dir name can't collide with a global skill", async () => {
    // Local skill dir "foo" but frontmatter name "bar"; a global skill named "foo". Both are
    // materialized BY NAME (skills/bar, skills/foo) — distinct, no collision, both shipped.
    const src = await mkdtemp(join(tmpdir(), "fa-bundle-src-"));
    await writeFile(join(src, "AGENTS.md"), "# Bot\n");
    await mkdir(join(src, "skills", "foo"), { recursive: true });
    await writeFile(join(src, "skills", "foo", "SKILL.md"), "---\nname: bar\ndescription: d\n---\nbody\n");
    const ext = await mkdtemp(join(tmpdir(), "fa-bundle-ext-"));
    await mkdir(join(ext, "foo"), { recursive: true });
    await writeFile(join(ext, "foo", "SKILL.md"), "---\nname: foo\ndescription: d\n---\nbody\n");
    const out = await mkdtemp(join(tmpdir(), "fa-bundle-out-"));
    await bundleAgentDefinition(src, out, { skillPaths: [ext] });
    const dirs = (await readdir(join(out, "skills"))).sort();
    expect(dirs).toEqual(["bar", "foo"]); // by name, not by source dir name
    const reloaded = await loadAgentDefinition(out, { skillPaths: [] });
    expect(reloaded.skills.map((s) => s.name).sort()).toEqual(["bar", "foo"]);
  });
});
