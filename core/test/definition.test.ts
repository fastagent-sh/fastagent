import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FileError, err } from "@earendil-works/pi-agent-core";
import {
  assembleSystemPrompt,
  bundleAgentDefinition,
  collect,
  createPiAgentFromDefinition,
  defaultGlobalSkillPaths,
  loadAgentDefinition,
  piBasePrompt,
  piDefaultTools,
  piReadOnlyTools,
  type CreatePiAgentFromDefinitionOptions,
} from "../src/index.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agent");
const extraSkillsDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "extra-skills");

describe("definition: loadAgentDefinition", () => {
  it("读出 instructions(AGENTS.md)+ skills(SKILL.md frontmatter)", async () => {
    const def = await loadAgentDefinition(fixtureDir, { skillPaths: [] });
    expect(def.instructions).toContain("Haiku Bot");
    expect(def.instructions).toContain("5-7-5");
    expect(def.dir).toBe(fixtureDir); // AGENTS.md path is derivable: join(dir, "AGENTS.md")
    expect(def.skills).toHaveLength(1);
    expect(def.skills[0]!.name).toBe("season-words");
    expect(def.skills[0]!.description).toContain("kigo");
    expect(def.diagnostics).toHaveLength(0);
  });

  it("缺 AGENTS.md / 缺 skills/ → instructions undefined、skills 空,不抛", async () => {
    const def = await loadAgentDefinition("/tmp", { skillPaths: [] }); // a directory with no definition
    expect(def.instructions).toBeUndefined();
    expect(def.skills).toEqual([]);
  });

  it("AGENTS.md 读取遇非 not_found 错误 → 抛出,不静默变成「无 instructions」", async () => {
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

  it("缺省 skillPaths = 全局目录(pi parity):~/.pi/agent/skills + ~/.agents/skills", () => {
    const paths = defaultGlobalSkillPaths();
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/\.pi\/agent\/skills$/);
    expect(paths[1]).toMatch(/\.agents\/skills$/);
  });

  it("skillPaths 额外挂载:新 skill 进来;同名碰撞定义内赢且 surface collision", async () => {
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

  it("skillPaths: [] → 只扫定义内(确定性部署姿态)", async () => {
    const def = await loadAgentDefinition(fixtureDir, { skillPaths: [] });
    expect(def.skills.map((s) => s.name)).toEqual(["season-words"]);
    expect(def.collisions).toEqual([]);
  });
});

describe("create: assembleSystemPrompt(四段式)", () => {
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

  it("base 可覆盖;无 instructions/skills 时不输出空块", () => {
    const prompt = assembleSystemPrompt({ base: "CUSTOM BASE" });
    expect(prompt).toContain("CUSTOM BASE");
    expect(prompt).not.toContain("operating inside pi"); // after override the engine base is gone
    expect(prompt).not.toContain("<project_instructions");
    expect(prompt).not.toContain("<available_skills>");
  });

  it("piBasePrompt 按实际 tools 生成工具列表(base 与工具集一致)", () => {
    const withTools = piBasePrompt({ tools: piDefaultTools(fixtureDir) });
    expect(withTools).toContain("- read:");
    expect(withTools).toContain("- bash:");
    expect(piBasePrompt()).toContain("(none)");
  });
});

describe("create L2: 类型只承诺实现尊重的东西", () => {
  it("L2 options 不接受 skills/systemPrompt(它们来自定义文件夹)", () => {
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

describe("create: createPiAgentFromDefinition(指向文件夹 → agent)", () => {
  it("组装的 systemPrompt 真到达模型;skills 注入 resources;read 工具默认在", async () => {
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

describe("create: 工具集(pi 真工具,忠实性)", () => {
  it("piDefaultTools = pi 核心 4 件套(同 pi 默认);piReadOnlyTools = 只读子集", () => {
    expect(piDefaultTools(fixtureDir).map((t) => t.name).sort()).toEqual([
      "bash", "edit", "read", "write",
    ]);
    const ro = piReadOnlyTools(fixtureDir).map((t) => t.name);
    expect(ro).not.toContain("bash");
    expect(ro).not.toContain("write");
    expect(ro).toContain("read");
  });

  it("pi 的 read 工具真能读 fixture(与 pi 本地同行为)", async () => {
    const read = piDefaultTools(fixtureDir).find((t) => t.name === "read")!;
    const r = await read.execute("t1", { path: "AGENTS.md" });
    const text = (r.content[0] as any).text as string;
    expect(text).toContain("Haiku Bot");
  });
});

describe("definition: bundleAgentDefinition(构建时把额外挂载物化进可部署包)", () => {
  it("产物自包含:AGENTS.md + 胜出的 skills 整夹;败者不进包", async () => {
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
});
