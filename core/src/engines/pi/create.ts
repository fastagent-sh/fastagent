/**
 * Agent assembly — everything CONFIGURATION-TIME lives in this module.
 * (Division of labor: invoke.ts decides HOW a turn runs, request time; this
 * module decides WHAT parts an agent is assembled from, configuration time.)
 *
 * Organized as the engine-asset parts plus the reusable assembly ladder that consumes them:
 *
 *   §1 tools   — pi default toolset (engine asset)
 *   §2 prompt  — four-segment systemPrompt assembly (pure functions)
 *   §3 ladder  — the reusable rungs that put a pi agent together (L0–L2).
 *
 * Ladder naming rule: `From<source>` marks INDIRECTION — that rung derives its
 * inputs from the named source (a definition folder, engine wiring). L1 carries no
 * suffix: its inputs are given directly as typed options — it is the canonical
 * constructor every other rung ultimately calls. Each rung also has a semantic verb —
 * what its fold actually does — used as its label below:
 *
 *   L2  createPiAgentFromDefinition(dir, options)       (this file)     [LOAD]
 *       "Load the portable agent definition": definition.ts loads, §2 assembles,
 *       then L1. For folder-based embedding.
 *   L1  createPiAgent(options)                          (this file)     [ASSEMBLE]
 *       "Assemble from typed parts": every M/K/auth input explicit, every default
 *       overridable. For embedding with hand-picked parts.
 *   L0  createPiAgentFromHarness({ harnessFactory })    (invoke.ts)     [ADAPT]
 *       "Adapt engine wiring to the Agent contract": adds only the concurrency/
 *       stream shell. For tests and fully custom wiring.
 *
 * Above L2 sits the COMMAND OPENER — not a ladder rung, but a command-posture
 * composition that opens a directory, resolves model/tools, picks session storage, then
 * calls L2: createPiAgentFromWorkspace (dev.ts), which BOTH `dev` and `start` drive (the
 * directory IS the agent — no build, no artifact). It owns command policy (config
 * precedence, the .fastagent session dir, the sessionsDir override); the ladder owns
 * engine assembly.
 *
 * Each rung only calls the one below; options narrow as you go up (L2 owns
 * systemPrompt/skills itself — they come from the definition; the openers own model/tools —
 * they come from the config resolution, so L2's options deliberately do not
 * accept them as the openers' job).
 *
 * Two ladder-wide rules, written down so the per-rung choices stay explainable:
 *
 * 1. L0 is the odd rung out: L1–L2 fold *configuration
 *    inputs* (files → values → closures); L0 adapts *behavior* (pi's two ports →
 *    SPEC stream + concurrency discipline) — strictly an Adapter. It joins the
 *    create… family by NAME because it is a legitimate entry point (discoverability),
 *    but lives in invoke.ts because its body IS the turn mechanism (cohesion).
 *
 * 2. An injection point climbs only as high as the last persona who owns the
 *    decision, then stops:
 *      - sessions / lease (deployment backends)  → reach L2 (embedding developer);
 *        the openers pick their own default (jsonl under <dir>/.fastagent/, which start can
 *        override to a mounted volume) without exposing a choice;
 *      - base (definition-assembly)               → stop at L2 (L2 owns prompt/skill mounting);
 *      - retryClassifier (engine adaptation)     → stays at L0 (custom-wiring persona);
 *      - an opener exposes only what an operator may say: the model flag. Skills are
 *        always definition-only (your folder is the agent — no scope toggle, no mount path).
 *    KNOWN DEBT: "the openers accept no K" is a v1 line, not an invariant — sessions/env
 *    ARE deployment choices semantically. When backend #2 lands (DDB / sandbox env),
 *    this boundary must be re-cut: either config grows K keys (the openers inherit them)
 *    or opener options grow K overrides. Decide from real backends; do not pre-wire.
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

// ── §1 tools: pi's real built-in core coding tools (engine assets) ───────────
//
// Stance:
//   - **Full default toolset = fidelity**: definition authors vibe in local pi with the
//     full toolset; serving with fewer tools = behavior drift (same logic as the base
//     prompt). We use pi-coding-agent's factories so tool names/descriptions/behavior
//     match local pi verbatim.
//   - **The tool layer is not the security boundary**: isolation is the K-side
//     ExecutionEnv/sandbox's job (local = the user's own machine; AgentCore = microVM).
//     Locking down for public exposure = explicitly passing a restricted `tools`
//     list — a deployment posture, not the default.
//   - pi tools take injectable operations (BashOperations etc.); a future sandbox
//     adapter swaps operations rather than being locked to local fs.

/** pi's core default toolset (read/bash/edit/write, matching pi defaults), rooted at cwd. */
export function piDefaultTools(cwd: string): AgentTool[] {
  return createCodingTools(cwd) as AgentTool[];
}

/**
 * Materialize the documented `config.tools` semantics: extra tools are APPENDED
 * after pi's defaults, never replacing them. Used by the dev/start openers; exported
 * for callers assembling manually from a loaded config.
 */
export function resolveTools(config: FastagentConfig, cwd: string): AgentTool[] {
  const defaults = piDefaultTools(cwd);
  return config.tools ? [...defaults, ...config.tools] : defaults;
}

/**
 * Resolve the full tool set a workspace mounts: pi defaults + `config.tools` + discovered
 * `tools/` (deduped, existing win), plus the non-default tool names and the collisions to report.
 * The single source of this resolution for the dev/start openers AND `fastagent tool` — they must
 * mount exactly the same set, so it lives here once instead of being copied per opener.
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

// ── §2 prompt: four-segment systemPrompt assembly (core-design §2) ───────────
//
//   systemPrompt = ① base (engine asset) + ② instructions (<project_instructions>-wrapped)
//                + ③ skills listing + ④ env context (date/cwd)
//
// AGENTS.md ≠ system prompt. Pure functions: no IO, no clock — segment ④ inputs
// (date/cwd) are provided by the caller, so the same inputs always produce the
// same prompt (testable, reproducible).

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
   * Base prompt (①), REQUIRED — deliberately no default: a defaulted
   * piBasePrompt() would render "Available tools: (none)" even when tools are
   * mounted (base and toolset must agree). Pass piBasePrompt({ tools }) for pi.
   */
  base: string;
  /** ② AGENTS.md content (verbatim), injected wrapped — never pasted bare. */
  instructions?: string;
  /** Path rendered into the <project_instructions path=…> attribute (lets the model re-read the file). */
  instructionsPath?: string;
  /** ③ Skills for the <available_skills> listing. */
  skills?: Skill[];
  /** ④ Env context, caller-provided (keeps this function pure). Omitted = segment omitted. */
  date?: string;
  cwd?: string;
}

/** Assemble the final system prompt (four segments, with the pi-isomorphic <project_instructions> wrapper). */
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

// ── §3 the reusable assembly ladder: L1 / L2 (L0 lives in invoke.ts) ─────────
//
// The command opener (createPiAgentFromWorkspace in dev.ts) composes OVER L2 and lives in its
// own command module — see the header. Both `dev` and `start` drive it.

/** L1 options, grouped by the two-axis model (core-design §6.1). */
export interface CreatePiAgentOptions {
  // ── M: what the agent is ───────────────────────────────────────────────
  /**
   * Provider collection for model requests + auth. Defaults to {@link createPiModels}
   * (built-in providers; pi OAuth file then env vars). Inject a custom collection
   * to change providers or auth. {@link model} must belong to it (same provider id).
   */
  models?: Models;
  model: AnyModel;
  /**
   * The FINAL assembled prompt (see §2 for assembly from parts), or a
   * factory re-evaluated per invoke (keeps time-sensitive segments fresh).
   */
  systemPrompt?: string | (() => string);
  tools?: AgentTool[];
  /** Skills visible to the model / explicitly invokable (injected as harness resources). */
  skills?: Skill[];
  // ── K: where/how it runs ───────────────────────────────────────────────
  /** Session persistence. Defaults to in-memory (embedding/tests); inject jsonlSessionStore for restart-surviving continuity. */
  sessions?: PiSessionStore;
  /** Tool execution environment. Defaults to local NodeExecutionEnv (cwd); production injects sandbox/e2b. */
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
 * L2 options — written out explicitly (no Omit<> surgery) so the type can only
 * promise what the implementation honors. Notably absent by design:
 * `systemPrompt` (assembled from the definition) and `skills` (they come from
 * the definition folder — that is the whole point of L2).
 */
export interface CreatePiAgentFromDefinitionOptions {
  // ── M ──────────────────────────────────────────────────────────────────
  /** Provider collection for model requests + auth. Defaults to {@link createPiModels}. */
  models?: Models;
  model: AnyModel;
  /** Override the base prompt (segment ①). Defaults to piBasePrompt({tools}) (engine-inherited). */
  base?: string;
  /** Override tools. Defaults to piDefaultTools (full pi toolset, fidelity; lock down with a custom list). */
  tools?: AgentTool[];
  // ── K ──────────────────────────────────────────────────────────────────
  sessions?: PiSessionStore;
  env?: ExecutionEnv;
  lease?: Lease;
}

/**
 * L2: "point at a folder → agent": load + assemble + L1 in one call.
 * Returns the definition so callers can surface diagnostics/collisions.
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
    // M — assembled here from the definition (no spread: every field deliberate)
    models: options.models,
    model: options.model,
    // Factory, not a string: re-assembled per invoke so `date` is the date of the
    // turn, not of agent creation (long-running deployments would otherwise serve
    // the boot date forever). Static segments are captured once above.
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
    // K + auth — pass-through
    sessions: options.sessions,
    env,
    lease: options.lease,
  });
  return { agent, definition };
}

// The command OPENER that composes over L2 lives in its own command module:
//   dev / start → createPiAgentFromWorkspace  (dev.ts)
// keeping create.ts the pure reusable ladder (L0–L2 + engine assets). See the header.
