/**
 * Driver: read an agent definition folder (AGENTS.md + skills/) → produce the
 * M-side "definition-derived" artifacts.
 *
 * Stance (core-design §2, four-segment prompt): AGENTS.md ≠ system prompt.
 *   - The driver produces **instructions** (AGENTS.md content) + **skills**, not a systemPrompt;
 *   - the final systemPrompt is assembled by assembleSystemPrompt: base (engine asset)
 *     + instructions (wrapped in <project_instructions>, isomorphic to pi/Claude Code)
 *     + skills listing + env context;
 *   - model is a config item, not the driver's job (AGENTS.md does not say which LLM);
 *   - `.mcp.json` (MCP tools) is a separate future knife, not in this version.
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

/** A same-name skill collision (the discarded side). Must surface, never swallowed (fail visibly). */
export interface SkillCollision {
  name: string;
  winnerPath: string;
  loserPath: string;
}

/** Definition-derived artifacts (the M "definition" cell). diagnostics/collisions must surface. */
export interface AgentDefinition {
  /** AGENTS.md content; undefined when the file does not exist. */
  instructions?: string;
  /** Absolute path of AGENTS.md (when present). */
  instructionsPath?: string;
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
  collisions: SkillCollision[];
  dir: string;
}

/**
 * Default global skills directories (pi parity): pi user-level + the cross-tool
 * standard directory. loadSkills skips missing directories → on a dev machine this
 * matches local pi; on a server with no home it is naturally empty (fallback only —
 * the deploy path materializes via bundleAgentDefinition, the artifact is the truth).
 */
export function defaultGlobalSkillPaths(): string[] {
  return [join(homedir(), ".pi", "agent", "skills"), join(homedir(), ".agents", "skills")];
}

export interface LoadAgentDefinitionOptions {
  env?: ExecutionEnv;
  /**
   * Skills mount directories. **Default = defaultGlobalSkillPaths() (load globals,
   * faithful to the local pi experience)**; missing directories are skipped.
   * Advanced control:
   *   - `skillPaths: []` → definition-only (deterministic deployment posture);
   *   - custom array → precise control over what is mounted;
   *   - to materialize globals into a deployable artifact → bundleAgentDefinition.
   * Collisions: definition-local skills win (the deployable unit is authoritative);
   * first-wins + surfaced collision.
   */
  skillPaths?: string[];
}

/** Read a definition folder. env defaults to local Node (cwd=dir); non-local deployments inject their env. */
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

  const agentsPath = join(root, "AGENTS.md");
  const read = await e.readTextFile(agentsPath);
  // Only not_found means "no AGENTS.md". Anything else (permission, io) must surface,
  // otherwise the agent silently runs without instructions (AGENTS.md rule 8).
  if (!read.ok && read.error.code !== "not_found") {
    throw new Error(`cannot read ${agentsPath}: ${read.error.message}`);
  }
  const instructions = read.ok ? read.value : undefined;

  // Definition-local skills first → definition wins collisions (first-wins).
  // Default appends the global directories (pi parity).
  const { skills: raw, diagnostics } = await loadSkills(e, [
    join(root, "skills"),
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
 * The pi engine's base prompt (segment ①, inherited from the engine — not invented
 * by fastagent).
 *
 * Mirrors pi-coding-agent's buildSystemPrompt default path (identity + tool list +
 * guidelines), with two deliberate deviations: the pi-TUI docs section is dropped
 * (those local paths do not exist in deployments), and the tool list is generated
 * from the **actually mounted tools** (base and toolset must agree — pi's own
 * parameterization). Future claude/codex engine bindings will not need this: their
 * SDKs assemble their own prompts internally.
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
  /** Base prompt (①). Defaults to piBasePrompt() (engine-inherited; callers passing tools should use piBasePrompt({tools})). */
  base?: string;
  instructions?: string;
  instructionsPath?: string;
  skills?: Skill[];
  cwd?: string;
}

/** Assemble the final system prompt (four segments, with the pi-isomorphic <project_instructions> wrapper). */
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
 * Bundle (**the "compile" stage of one-click deploy, not an optional dev tool**):
 * materialize the resolved full skill set into a self-contained deployable folder —
 * the server reproduces the local experience exactly.
 *
 * Materialized: AGENTS.md + winning skill folders (including globals; scripts/
 * references/assets come along). Collision rules match loadAgentDefinition
 * (definition wins); losers are not bundled.
 * Note: **custom code tools are out of bundling scope** — they are code (with npm
 * dependencies); their deployment unit is "project + deps" via the project's normal
 * build/deploy (explicit `tools:` injection; copying source files without deps would
 * be fake self-containment). The standards-track for declarative tool mounting is
 * `.mcp.json` (MCP, a future knife).
 * The runtime's default global scan is local-dev convenience only; the deploy path
 * must go through this function — the artifact is the truth.
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
      // Standard skill folder: copy the whole directory (scripts/references/assets included).
      await cp(dirname(skill.filePath), join(outDir, "skills", skill.name), { recursive: true });
    } else {
      // Bare root-level .md skill file.
      await copyFile(skill.filePath, join(outDir, "skills", basename(skill.filePath)));
    }
  }
  return definition;
}

export type CreatePiAgentFromDefinitionOptions = Omit<CreatePiAgentOptions, "systemPrompt" | "tools"> & {
  /** Override the base prompt. Defaults to piBasePrompt({tools}) (engine-inherited). */
  base?: string;
  /** Override tools. Defaults to piDefaultTools (full pi toolset, fidelity; use piReadOnlyTools or a custom list to lock down). */
  tools?: AgentTool[];
  /** Extra skills mount directories (explicit; see LoadAgentDefinitionOptions.skillPaths). */
  skillPaths?: string[];
};

/**
 * "Point at a folder → agent": load + assemble + createPiAgent in one call.
 * Returns the definition so callers can surface diagnostics (warnings are not swallowed).
 */
export async function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: AgentDefinition }> {
  const env = options.env ?? new NodeExecutionEnv({ cwd: dir });
  const definition = await loadAgentDefinition(dir, { env, skillPaths: options.skillPaths });
  // Custom code tools = explicit injection (`tools: [...piDefaultTools(cwd), myTool]`); no magic directory.
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
