/**
 * Agent assembly (configuration-time): the engine assets (tools, prompt) plus the reusable ladder
 * that puts a pi agent together.
 *
 *   L2  createPiAgentFromDefinition(dir, options)   — load a definition folder, assemble, then L1.
 *   L1  createPiAgent(options)                       — assemble from typed parts (the canonical ctor).
 *   L0  createPiAgentFromHarness({ harnessFactory }) — in invoke.ts (its body is the turn mechanism).
 *
 * Above L2 sits the command opener createPiAgentFromWorkspace (dev.ts), which both `dev` and `start`
 * drive. Each rung calls the one below; options narrow as you go up (L2 owns systemPrompt/skills —
 * they come from the definition; the openers own model/tools — from config resolution).
 */
import { join } from "node:path";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import type { AgentTool, ExecutionEnv, Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import type { Models } from "@earendil-works/pi-ai";
import type { Agent } from "../../agent.ts";
import type { FastagentConfig } from "./config.ts";
import { type LoadedDefinition, loadAgentDefinition } from "./definition.ts";
import { type AnyModel, piHarnessFactory } from "./harness.ts";
import { createPiModels } from "./models.ts";
import { type PiSessionStore, inMemorySessionStore } from "./sessions.ts";
import { type ToolCollision, loadTools, mergeDiscoveredTools } from "./tool.ts";
import { type Lease, createPiAgentFromHarness } from "./invoke.ts";

// ── §1 tools ─────────────────────────────────────────────────────────────────
//
// The full pi toolset is the default for fidelity: authors vibe in local pi with it, so serving with
// fewer tools is behavior drift. Isolation is the K-side ExecutionEnv/sandbox's job, not the tool
// layer's; locking down for public exposure = passing a restricted `tools` list (a deployment posture).

/** pi's core default toolset (read/bash/edit/write), rooted at cwd. */
export function piDefaultTools(cwd: string): AgentTool[] {
  return createCodingTools(cwd) as AgentTool[];
}

/** `config.tools` semantics: extra tools APPENDED after pi's defaults, never replacing them. */
export function resolveTools(config: FastagentConfig, cwd: string): AgentTool[] {
  const defaults = piDefaultTools(cwd);
  return config.tools ? [...defaults, ...config.tools] : defaults;
}

/**
 * The full tool set a workspace mounts: pi defaults + `config.tools` + discovered `tools/` (deduped,
 * existing win), plus the non-default tool names and collisions to report. One source for the
 * dev/start openers AND `fastagent tool`, so they all mount exactly the same set.
 */
export async function resolveWorkspaceTools(
  config: FastagentConfig,
  dir: string,
): Promise<{ tools: AgentTool[]; toolNames: string[]; toolCollisions: ToolCollision[] }> {
  const discovered = await loadTools(dir);
  const { tools, collisions } = mergeDiscoveredTools(resolveTools(config, dir), discovered.tools);
  const toolCollisions = [...discovered.collisions, ...collisions];
  const defaultNames = new Set(piDefaultTools(dir).map((t) => t.name));
  const toolNames = tools.map((t) => t.name).filter((n) => !defaultNames.has(n));
  return { tools, toolNames, toolCollisions };
}

// ── §2 prompt: four-segment systemPrompt assembly ───────────────────────────
//
//   systemPrompt = ① base (engine asset) + ② instructions (<project_instructions>-wrapped)
//                + ③ skills listing + ④ env context (date/cwd)
//
// AGENTS.md ≠ system prompt. Pure functions: segment ④ inputs (date/cwd) are caller-provided, so the
// same inputs always produce the same prompt (testable, reproducible).

/**
 * The pi engine's base prompt (segment ①), mirroring pi-coding-agent's default path with two
 * deviations: the pi-TUI docs section is dropped (those paths don't exist in deployments), and the
 * tool list is generated from the actually-mounted tools (base and toolset must agree).
 */
export function piBasePrompt(options: { tools?: AgentTool[] } = {}): string {
  const tools = options.tools ?? [];
  const toolsList =
    tools.length > 0 ? tools.map((t) => `- ${t.name}: ${(t.description ?? "").split("\n")[0]}`).join("\n") : "(none)";
  return `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files`;
}

export interface AssembleSystemPromptOptions {
  /**
   * Base prompt (①), REQUIRED — no default: a defaulted piBasePrompt() would render
   * "Available tools: (none)" even when tools are mounted. Pass piBasePrompt({ tools }) for pi.
   */
  base: string;
  /** ② AGENTS.md content (verbatim), injected wrapped — never pasted bare. */
  instructions?: string;
  /** Path rendered into the <project_instructions path=…> attribute. */
  instructionsPath?: string;
  /** ③ Skills for the <available_skills> listing. */
  skills?: Skill[];
  /** ④ Env context, caller-provided (keeps this function pure). Omitted = segment omitted. */
  date?: string;
  cwd?: string;
}

export function assembleSystemPrompt(options: AssembleSystemPromptOptions): string {
  let prompt = options.base;
  if (options.instructions) {
    const pathAttr = options.instructionsPath ? ` path="${options.instructionsPath}"` : "";
    prompt +=
      `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n` +
      `<project_instructions${pathAttr}>\n${options.instructions}\n</project_instructions>\n\n</project_context>\n`;
  }
  if (options.skills && options.skills.length > 0) {
    prompt += `\n${formatSkillsForSystemPrompt(options.skills)}\n`;
  }
  if (options.date) prompt += `\nCurrent date: ${options.date}`;
  if (options.cwd) prompt += `\nCurrent working directory: ${options.cwd}`;
  return prompt;
}

// ── §3 the reusable assembly ladder: L1 / L2 ────────────────────────────────

/** L1 options, grouped by the two-axis model: M (what the agent is) + K (where/how it runs). */
export interface CreatePiAgentOptions {
  // ── M ───────────────────────────────────────────────────────────────────
  /**
   * Provider collection for model requests + auth. Defaults to {@link createPiModels}. {@link model}
   * must belong to it (same provider id).
   */
  models?: Models;
  model: AnyModel;
  /** The FINAL assembled prompt, or a factory re-evaluated per invoke (keeps time-sensitive segments fresh). */
  systemPrompt?: string | (() => string);
  tools?: AgentTool[];
  skills?: Skill[];
  // ── K ───────────────────────────────────────────────────────────────────
  /** Session persistence. Defaults to in-memory; inject jsonlSessionStore for restart-surviving continuity. */
  sessions?: PiSessionStore;
  /** Tool execution environment. Defaults to local NodeExecutionEnv (cwd); production injects a sandbox. */
  env?: ExecutionEnv;
  /** Single-writer lease. Defaults to in-process fail-fast inProcessLease(). */
  lease?: Lease;
}

/** L1: batteries-included assembly. */
export function createPiAgent(options: CreatePiAgentOptions): Agent {
  return createPiAgentFromHarness({
    lease: options.lease,
    harnessFactory: piHarnessFactory({
      sessions: options.sessions ?? inMemorySessionStore(),
      env: options.env ?? new NodeExecutionEnv({ cwd: process.cwd() }),
      models: options.models ?? createPiModels(),
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      skills: options.skills,
    }),
  });
}

/**
 * L2 options. `systemPrompt` and `skills` are absent by design: they are assembled from the
 * definition folder — the whole point of L2.
 */
export interface CreatePiAgentFromDefinitionOptions {
  models?: Models;
  model: AnyModel;
  /** Override the base prompt (segment ①). Defaults to piBasePrompt({tools}). */
  base?: string;
  /** Override tools. Defaults to piDefaultTools (lock down with a custom list). */
  tools?: AgentTool[];
  sessions?: PiSessionStore;
  env?: ExecutionEnv;
  lease?: Lease;
}

/**
 * L2: "point at a folder → agent": load + assemble + L1 in one call. Returns the definition so
 * callers can surface diagnostics/collisions.
 */
export async function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: LoadedDefinition }> {
  const env = options.env ?? new NodeExecutionEnv({ cwd: dir });
  const definition = await loadAgentDefinition(dir, { env });
  const tools = options.tools ?? piDefaultTools(env.cwd);
  const base = options.base ?? piBasePrompt({ tools });
  const agent = createPiAgent({
    models: options.models,
    model: options.model,
    // Factory, not a string: re-assembled per invoke so `date` is the date of the turn, not of agent
    // creation (a long-running deployment would otherwise serve the boot date forever).
    systemPrompt: () =>
      assembleSystemPrompt({
        base,
        instructions: definition.instructions,
        instructionsPath: definition.instructions !== undefined ? join(definition.dir, "AGENTS.md") : undefined,
        skills: definition.skills,
        date: new Date().toISOString().slice(0, 10),
        cwd: env.cwd,
      }),
    tools,
    skills: definition.skills,
    sessions: options.sessions,
    env,
    lease: options.lease,
  });
  return { agent, definition };
}
