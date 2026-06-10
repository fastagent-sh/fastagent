/**
 * Driver:读 agent 定义文件夹(AGENTS.md + skills/)→ 产出 M 侧「定义推导」物。
 *
 * 口径(core-design §2 prompt 四段式):AGENTS.md ≠ system prompt。
 *   - driver 产出 **instructions**(AGENTS.md 内容)+ **skills**,不产出 systemPrompt;
 *   - 最终 systemPrompt = assembleSystemPrompt 组装:base(M 资产)+ instructions
 *     (包成 <project_instructions>,与 pi/Claude Code 同构)+ skills listing + env context;
 *   - model 是配置项,不归 driver(AGENTS.md 不讲用哪个 LLM);
 *   - `.mcp.json`(MCP tools)是后续单独一刀,本版不做。
 */
import { cp, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExecutionEnv, Skill, SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { formatSkillsForSystemPrompt, loadSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Agent } from "../../agent.ts";
import { type CreatePiAgentOptions, createPiAgent } from "./create.ts";
import { piDefaultTools } from "./tools.ts";

/** 同名 skill 碰撞(被丢弃的一方)。必须 surface,不吞(fail visibly)。 */
export interface SkillCollision {
  name: string;
  winnerPath: string;
  loserPath: string;
}

/** 定义推导物(M 的「定义」格)。diagnostics/collisions 必须 surface,不吞。 */
export interface AgentDefinition {
  /** AGENTS.md 内容;文件不存在则 undefined。 */
  instructions?: string;
  /** AGENTS.md 的绝对路径(存在时)。 */
  instructionsPath?: string;
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
  collisions: SkillCollision[];
  dir: string;
}

/**
 * 默认的全局 skills 目录(pi parity):pi 用户级 + 跨工具标准目录。
 * loadSkills 会跳过不存在的目录 → 开发机上 = pi 同款体验;服务器上没有 home = 自然为空。
 */
export function defaultGlobalSkillPaths(): string[] {
  return [join(homedir(), ".pi", "agent", "skills"), join(homedir(), ".agents", "skills")];
}

export interface LoadAgentDefinitionOptions {
  env?: ExecutionEnv;
  /**
   * skills 挂载目录。**缺省 = defaultGlobalSkillPaths()(默认加载全局,忠实 pi 本地体验)**;
   * 不存在的目录自动跳过(服务器上自然为空)。高级控制:
   *   - `skillPaths: []` → 只扫定义内(确定性部署姿态);
   *   - 自定义数组 → 精确控制挂载什么;
   *   - 要把全局物化进部署包 → bundleAgentDefinition。
   * 碰撞:定义内 skills 赢(部署单元是权威),先到者赢 + surface collision。
   */
  skillPaths?: string[];
}

/** 读定义文件夹。env 缺省本地 Node(cwd=dir);非本地部署注入对应 env。 */
export async function loadAgentDefinition(
  dir: string,
  options: LoadAgentDefinitionOptions = {},
): Promise<AgentDefinition> {
  const e = options.env ?? new NodeExecutionEnv({ cwd: dir });
  const rootResult = await e.absolutePath(dir);
  if (!rootResult.ok) {
    // No silent fallback: a failing absolutePath means the env itself is broken.
    throw new Error(`cannot resolve definition dir "${dir}": ${rootResult.error.message}`);
  }
  const root = rootResult.value;

  const agentsPath = `${root}/AGENTS.md`;
  const read = await e.readTextFile(agentsPath);
  // Only not_found means "no AGENTS.md". Anything else (permission, io) must surface,
  // otherwise the agent silently runs without instructions (AGENTS.md rule 8).
  if (!read.ok && read.error.code !== "not_found") {
    throw new Error(`cannot read ${agentsPath}: ${read.error.message}`);
  }
  const instructions = read.ok ? read.value : undefined;

  // 定义内 skills 在前 → 碰撞时定义赢(先到者赢)。缺省追加全局目录(pi parity)。
  const { skills: raw, diagnostics } = await loadSkills(e, [
    `${root}/skills`,
    ...(options.skillPaths ?? defaultGlobalSkillPaths()),
  ]);
  const byName = new Map<string, Skill>();
  const collisions: SkillCollision[] = [];
  for (const skill of raw) {
    const existing = byName.get(skill.name);
    if (existing) {
      collisions.push({ name: skill.name, winnerPath: existing.filePath, loserPath: skill.filePath });
    } else {
      byName.set(skill.name, skill);
    }
  }

  return {
    instructions,
    instructionsPath: read.ok ? agentsPath : undefined,
    skills: [...byName.values()],
    diagnostics,
    collisions,
    dir: root,
  };
}

/**
 * pi 引擎的 base prompt(①,继承自引擎,非 fastagent 自造)。
 *
 * 镜像 pi-coding-agent 的 buildSystemPrompt 默认路径(身份 + 工具列表 + guidelines),
 * 两处有意偏离:去掉 pi-TUI 文档段(部署环境不存在那些本机路径);工具列表按
 * **实际挂载的 tools** 生成(base 与工具集必须一致,同 pi 的参数化方式)。
 * 将来 claude/codex 引擎的 binding 不需要这个——它们的 SDK 内部自带各自的 prompt 组装。
 */
export function piBasePrompt(options: { tools?: AgentTool[] } = {}): string {
  const tools = options.tools ?? [];
  const toolsList =
    tools.length > 0
      ? tools.map((t) => `- ${t.name}: ${(t.description ?? "").split("\n")[0]}`).join("\n")
      : "(none)";
  return `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files`;
}

export interface AssembleSystemPromptOptions {
  /** base prompt(①)。缺省 piBasePrompt()(继承 pi 引擎;传 tools 的调用方应用 piBasePrompt({tools}))。 */
  base?: string;
  instructions?: string;
  instructionsPath?: string;
  skills?: Skill[];
  cwd?: string;
}

/** 组装最终 system prompt(四段式,与 pi 同构的 <project_instructions> 包裹)。 */
export function assembleSystemPrompt(options: AssembleSystemPromptOptions): string {
  let prompt = options.base ?? piBasePrompt();
  if (options.instructions) {
    const pathAttr = options.instructionsPath ? ` path="${options.instructionsPath}"` : "";
    prompt +=
      `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n` +
      `<project_instructions${pathAttr}>\n${options.instructions}\n</project_instructions>\n\n</project_context>\n`;
  }
  if (options.skills && options.skills.length > 0) {
    prompt += `\n${formatSkillsForSystemPrompt(options.skills)}\n`;
  }
  prompt += `\nCurrent date: ${new Date().toISOString().slice(0, 10)}`;
  if (options.cwd) prompt += `\nCurrent working directory: ${options.cwd}`;
  return prompt;
}

/**
 * 打包(**一键部署的「编译」阶段,不是可选 dev 工具**):把「解析后的完整 skill 集」
 * 物化进一个自包含的可部署文件夹——服务器上完整复现本地体验。
 *
 * 物化内容:AGENTS.md + 胜出的 skills 整夹(含全局,scripts/references/assets 一并)。
 * 碰撞规则同 loadAgentDefinition(定义内赢),败者不进包。
 * 注:**自定义 code tools 不在打包范围**——它们是代码(带 npm 依赖),部署单位是
 * 「项目+依赖」,随项目的正常构建/部署走(显式 `tools:` 注入;拷源文件不带依赖,
 * 伪自包含)。声明式挂工具的标准轨道是 `.mcp.json`(MCP,未来一刀)。
 * 运行时的默认全局扫描只是本地 dev 便利;部署路径必须经过本函数,产物才是真相。
 */
export async function bundleAgentDefinition(
  srcDir: string,
  outDir: string,
  options: LoadAgentDefinitionOptions = {},
): Promise<AgentDefinition> {
  const definition = await loadAgentDefinition(srcDir, options);
  await mkdir(join(outDir, "skills"), { recursive: true });
  if (definition.instructionsPath) {
    await copyFile(definition.instructionsPath, join(outDir, "AGENTS.md"));
  }
  for (const skill of definition.skills) {
    if (basename(skill.filePath) === "SKILL.md") {
      // 标准 skill 文件夹:整夹拷贝(含 scripts/references/assets)
      await cp(dirname(skill.filePath), join(outDir, "skills", skill.name), { recursive: true });
    } else {
      // 根部 .md 裸 skill 文件
      await copyFile(skill.filePath, join(outDir, "skills", basename(skill.filePath)));
    }
  }
  return definition;
}

export type CreatePiAgentFromDefinitionOptions = Omit<CreatePiAgentOptions, "systemPrompt" | "tools"> & {
  /** 覆盖 base prompt。缺省 piBasePrompt({tools})(继承 pi 引擎)。 */
  base?: string;
  /** 覆盖工具。缺省 piDefaultTools(完整 pi 工具集,忠实性;收紧姿态用 piReadOnlyTools 或自定义)。 */
  tools?: AgentTool[];
  /** 额外 skills 挂载目录(显式;见 LoadAgentDefinitionOptions.skillPaths 口径)。 */
  skillPaths?: string[];
};

/**
 * 「指向文件夹 → agent」:load + assemble + createPiAgent 一次调用。
 * 返回 definition 以便 caller surface diagnostics(不吞警告)。
 */
export async function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: AgentDefinition }> {
  const env = options.env ?? new NodeExecutionEnv({ cwd: dir });
  const definition = await loadAgentDefinition(dir, { env, skillPaths: options.skillPaths });
  // 自定义 code tools = 显式注入(`tools: [...piDefaultTools(cwd), myTool]`),不做魔法目录。
  const tools = options.tools ?? piDefaultTools(env.cwd);
  const agent = createPiAgent({
    ...options,
    env,
    systemPrompt: assembleSystemPrompt({
      base: options.base ?? piBasePrompt({ tools }),
      instructions: definition.instructions,
      instructionsPath: definition.instructionsPath,
      skills: definition.skills,
      cwd: env.cwd,
    }),
    tools,
    skills: definition.skills,
  });
  return { agent, definition };
}
