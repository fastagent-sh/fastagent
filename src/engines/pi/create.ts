/**
 * Agent assembly (configuration-time): the engine assets (tools, prompt) plus the reusable ladder
 * that puts a pi agent together.
 *
 *   L2  createPiAgentFromDefinition(dir, options)   — load a definition directory, assemble, then L1.
 *   L1  createPiAgent(options)                       — assemble from typed parts (the canonical ctor).
 *   L0  createPiAgentFromHarness({ harnessFactory }) — in invoke.ts (its body is the turn mechanism).
 *
 * Above L2 sits the workspace opener createPiAgentFromWorkspace (workspace.ts), which both `dev` and
 * `start` drive. Each rung calls the one below; options narrow as you go up (L2 owns systemPrompt/skills —
 * they come from the definition; the openers own model/tools — from config resolution).
 */
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import type { AgentTool, ExecutionEnv, Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import type { Agent } from "../../agent.ts";
import { type FastagentConfig, defaultAuthPath, resolveModel, resolveStateRoot } from "./config.ts";
import { type LoadedDefinition, loadAgentDefinition } from "./definition.ts";
import { piHarnessFactory } from "./harness.ts";
import { createPiModels } from "./models.ts";
import { reportDefinitionWarnings } from "./report.ts";
import { type PiSessionStore, inMemorySessionStore } from "./sessions.ts";
import type { ModuleLoadFailure } from "../../loader.ts";
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
  agentDir: string,
  cwd: string = agentDir,
): Promise<{
  tools: AgentTool[];
  toolNames: string[];
  toolCollisions: ToolCollision[];
  toolFailures: ModuleLoadFailure[];
}> {
  // Default coding tools (read/bash/edit/write) are rooted at `cwd` (the run root the agent operates on);
  // discovered `tools/` come from `agentDir` (the agent's own surface). They coincide in the flat case.
  const discovered = await loadTools(agentDir);
  const { tools, collisions } = mergeDiscoveredTools(resolveTools(config, cwd), discovered.tools);
  const toolCollisions = [...discovered.collisions, ...collisions];
  const defaultNames = new Set(piDefaultTools(cwd).map((t) => t.name));
  const toolNames = tools.map((t) => t.name).filter((n) => !defaultNames.has(n));
  return { tools, toolNames, toolCollisions, toolFailures: discovered.failures };
}

// ── §2 prompt: four-segment systemPrompt assembly ───────────────────────────
//
//   systemPrompt = ① base (engine asset; a persona.md persona overrides its identity line)
//                + ② project context (AGENTS.md files via pi's loadProjectContextFiles, <project_context>-wrapped)
//                + ③ skills listing + ④ env context (cwd)
//
// AGENTS.md ≠ system prompt. Pure functions: segment ④ input (cwd) is caller-provided, so the
// same inputs always produce the same prompt (testable, reproducible). No date: a date line would
// invalidate the provider prompt cache (a prefix cache) for every session at each day boundary —
// channel sessions routinely live for weeks (pi ≥0.80.7 dropped it from its default prompt for the
// same reason). The model gets the date when it needs it: `bash date`, and the wake tool takes
// relative delays ("30m") / cron — never an absolute now-derived instant.

/**
 * The pi engine's base prompt (segment ①), mirroring pi-coding-agent's default path with two
 * deviations: the pi-TUI docs section is dropped (those paths don't exist in deployments), and the
 * tool list is generated from the actually-mounted tools (base and toolset must agree). An authored
 * `persona` (from persona.md) replaces the default identity line, keeping the tools list + guidelines.
 */
export function piBasePrompt(options: { tools?: AgentTool[]; persona?: string } = {}): string {
  const tools = options.tools ?? [];
  const toolsList =
    tools.length > 0 ? tools.map((t) => `- ${t.name}: ${(t.description ?? "").split("\n")[0]}`).join("\n") : "(none)";
  // Segment ① identity: an authored persona (persona.md) replaces the default engine identity line
  // (the standalone×code-repo cell's persona; core.md §11), keeping the tools list + guidelines below.
  const identity =
    options.persona?.trim() ||
    "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
  return `${identity}

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
  /** ② project-context files (AGENTS.md et al. from loadProjectContextFiles); each wrapped `<project_instructions path=…>`. */
  contextFiles?: Array<{ path: string; content: string }>;
  /** ③ Skills for the <available_skills> listing. */
  skills?: Skill[];
  /** ④ Env context, caller-provided (keeps this function pure). Omitted = segment omitted. */
  cwd?: string;
}

export function assembleSystemPrompt(options: AssembleSystemPromptOptions): string {
  let prompt = options.base;
  const contextFiles = options.contextFiles ?? [];
  if (contextFiles.length > 0) {
    // Mirrors pi's system-prompt.js: one <project_context> block, one <project_instructions path=…> per file.
    prompt += `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n`;
    for (const { path, content } of contextFiles) {
      prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
    }
    prompt += `</project_context>\n`;
  }
  if (options.skills && options.skills.length > 0) {
    prompt += `\n${formatSkillsForSystemPrompt(options.skills)}\n`;
  }
  if (options.cwd) prompt += `\nCurrent working directory: ${options.cwd}`;
  return prompt;
}

// ── §3 the reusable assembly ladder: L1 / L2 ────────────────────────────────

/**
 * Shared low-level wiring: resolve the model spec against the collection, default the K ports, build
 * the agent. Internal — the public rungs decide the systemPrompt (L1 from instructions, L2 from the
 * directory) and route through here.
 */
function buildPiAgent(opts: {
  model: string;
  thinkingLevel?: ThinkingLevel;
  providers?: Provider[];
  authPath?: string;
  systemPrompt?: string | (() => string);
  tools?: AgentTool[];
  skills?: Skill[];
  /** Per-invoke prompt+skills source (see {@link PiHarnessFactoryOptions.live}); supersedes the two above. */
  live?: () => Promise<{ systemPrompt?: string; skills?: Skill[] }>;
  sessions?: PiSessionStore;
  env?: ExecutionEnv;
  lease?: Lease;
}): Agent {
  const models = createPiModels({ providers: opts.providers, authPath: opts.authPath });
  return createPiAgentFromHarness({
    lease: opts.lease,
    harnessFactory: piHarnessFactory({
      sessions: opts.sessions ?? inMemorySessionStore(),
      env: opts.env ?? new NodeExecutionEnv({ cwd: process.cwd() }),
      models,
      model: resolveModel(models, opts.model),
      thinkingLevel: opts.thinkingLevel,
      systemPrompt: opts.systemPrompt,
      tools: opts.tools,
      skills: opts.skills,
      live: opts.live,
    }),
  });
}

/**
 * L1 system prompt: `instructions` ARE the prompt (no engine base, no wrapping); the skills listing
 * is appended only when skills are mounted (the model must know what it can invoke). A factory so a
 * dynamic `instructions` and per-invoke freshness both work; undefined when there is nothing to send.
 */
function instructionsPrompt(
  instructions: string | (() => string) | undefined,
  skills: Skill[] | undefined,
): (() => string) | undefined {
  const hasSkills = skills !== undefined && skills.length > 0;
  if (instructions === undefined && !hasSkills) return undefined;
  return () => {
    const prose = typeof instructions === "function" ? instructions() : (instructions ?? "");
    const listing = hasSkills ? formatSkillsForSystemPrompt(skills as Skill[]) : "";
    return [prose, listing].filter((s) => s !== "").join("\n");
  };
}

/** L1 options. Tier 1: model (spec) + instructions + tools. Tier 2: the injectable ports. */
export interface CreatePiAgentOptions {
  /** Model spec "provider/modelId" (e.g. "openai-codex/gpt-5.5"), resolved against {@link models}. */
  model: string;
  /** Reasoning effort (pi's scale). Unset = pi's default; unsupported levels are clamped per model. */
  thinkingLevel?: ThinkingLevel;
  /**
   * The system prompt itself — verbatim, no engine base and no wrapping (unlike the directory path,
   * which assembles the engine base + AGENTS.md as segment ② + persona.md as segment ①). A plain string
   * or a factory re-evaluated per invoke. When {@link skills} are mounted their listing is appended.
   */
  instructions?: string | (() => string);
  tools?: AgentTool[];
  skills?: Skill[];
  // ── Tier 2: injectable ports ───────────────────────────────────────────────
  /**
   * Extra providers registered on top of the built-ins — your own gateway / self-hosted endpoint /
   * test fake — selected by the `model` spec's provider id. Built-ins cover the rest; static keys
   * still come from the {@link authPath} credentials file (fastagent login) or env, not from here.
   */
  providers?: Provider[];
  /**
   * Credentials file for stored OAuth/API-key auth. Defaults to `~/.fastagent/auth.json`; the
   * directory opener passes the project-level `<dir>/.fastagent/auth.json` instead. Env vars are still
   * consulted when a provider is absent from the file (resolution order is upstream-owned).
   */
  authPath?: string;
  /** Session persistence. Defaults to in-memory; inject jsonlSessionStore for restart-surviving continuity. */
  sessions?: PiSessionStore;
  /** Harness filesystem/process environment. Defaults to local NodeExecutionEnv (cwd). This is not yet
   *  a sandbox boundary for pi's cwd-bound coding tools; a sandbox adapter must wire those tools too. */
  env?: ExecutionEnv;
  /** Single-writer lease. Defaults to in-process fail-fast inProcessLease(). */
  lease?: Lease;
}

/** L1: assemble from typed parts. */
export function createPiAgent(options: CreatePiAgentOptions): Agent {
  return buildPiAgent({
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    providers: options.providers,
    authPath: options.authPath,
    systemPrompt: instructionsPrompt(options.instructions, options.skills),
    tools: options.tools,
    skills: options.skills,
    sessions: options.sessions,
    env: options.env,
    lease: options.lease,
  });
}

/**
 * L2 options. `instructions`/`skills` are absent by design — they come from the definition directory
 * (AGENTS.md + skills/), which is the whole point of L2.
 */
export interface CreatePiAgentFromDefinitionOptions {
  /** Model spec "provider/modelId", resolved against {@link models}. */
  model: string;
  /** Reasoning effort (pi's scale). Unset = pi's default; unsupported levels are clamped per model. */
  thinkingLevel?: ThinkingLevel;
  /** Override the engine base prompt (segment ①). Defaults to piBasePrompt({ tools, persona }) using the
   *  live-read persona.md; pass base to fully opt out of persona.md. */
  base?: string;
  /** Override tools. Defaults to piDefaultTools (lock down with a custom list). */
  tools?: AgentTool[];
  /**
   * The agent's working directory: where the default tools operate AND whose ancestors are walked for
   * ② project context (AGENTS.md). Defaults to `dir` (flat: the definition dir is also the run root).
   * Set it to the enclosing repo so a coding agent whose definition lives in `dir` operates on — and
   * reads the AGENTS.md of — that repo (core.md scenario grid).
   */
  cwd?: string;
  /** Extra providers registered on top of the built-ins (your own gateway / self-hosted endpoint). */
  providers?: Provider[];
  /**
   * Credentials file (see {@link CreatePiAgentOptions.authPath}). Being dir-aware, this rung defaults
   * to the PROJECT-level `<dir>/.fastagent/auth.json` (matching `fastagent dev`/`start` on the same
   * dir) — unlike the dir-less {@link createPiAgent}/{@link createPiModels}, which default global.
   */
  authPath?: string;
  sessions?: PiSessionStore;
  /** Harness environment; see {@link CreatePiAgentOptions.env}. The default coding tools and project-
   *  context loader remain local today, so injecting this alone does not sandbox a directory agent. */
  env?: ExecutionEnv;
  lease?: Lease;
}

/** Stable identity of a definition's non-fatal findings, for change-detection in `live` (dedup only). */
function findingsSignature(def: LoadedDefinition): string {
  const collisions = def.collisions.map((c) => `c:${c.name}:${c.winnerPath}:${c.loserPath}`);
  const diagnostics = def.diagnostics.map((d) => `d:${d.code}:${d.path}`);
  return [...collisions, ...diagnostics].sort().join("\n");
}

/**
 * L2: "point at a directory → agent": load + assemble (base + AGENTS.md + skills + env) + L1 in one
 * call. Returns the definition so callers can surface diagnostics/collisions.
 */
export async function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: LoadedDefinition }> {
  // `dir` = the agent-definition dir (persona.md/skills/); `cwd` (default = dir) is the run root where
  // tools operate and whose ancestors are walked for ② context.
  const cwd = options.cwd ?? dir;
  const env = options.env ?? new NodeExecutionEnv({ cwd });
  // Boot-time load: fail-visibly at startup on a broken directory, and give callers the snapshot to
  // report (skills/diagnostics/collisions). Serving does NOT close over it — see `live` below.
  const definition = await loadAgentDefinition(dir, { cwd: env.cwd, env });
  // Findings the caller already reported at boot; `live` re-reports only when the set CHANGES — a
  // runtime-written bad skill surfaces the moment it appears, while a static finding does not spam
  // every turn's log. A log-dedup memo, not session state (stateless invoke holds).
  let reportedFindings = findingsSignature(definition);
  const tools = options.tools ?? piDefaultTools(env.cwd);
  const agent = buildPiAgent({
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    providers: options.providers,
    // Dir-aware default: the same state-root-derived file the opener uses for this dir (the opener
    // passes an explicit authPath, so this only affects direct L2 callers).
    authPath: options.authPath ?? defaultAuthPath(resolveStateRoot(dir)),
    // The directory is the agent, LIVE: re-read the definition on every invoke, so AGENTS.md/skills
    // edits (the author's, or the agent's own self-modification) take effect on the next turn with
    // no process restart — restarts are reserved for code (tools/channels/config, module cache).
    // One read yields prompt AND skills (they can never diverge), and the
    // fs cost is a few reads against a model call. Broken edits stay visible: a throw-class problem
    // (unreadable AGENTS.md) fails that turn's invoke, and the loader's NON-fatal findings (bad
    // SKILL.md frontmatter, name collisions — returned as data, not thrown) are warned the moment
    // the finding set changes (boot findings are the baseline) — a runtime-written bad skill must
    // not silently vanish from the agent, and a static one must not spam every turn's log. The
    // next good edit heals both.
    live: async () => {
      const def = await loadAgentDefinition(dir, { cwd: env.cwd, env });
      const sig = findingsSignature(def);
      if (sig !== reportedFindings) {
        reportedFindings = sig;
        reportDefinitionWarnings(def.collisions, def.diagnostics);
      }
      return {
        systemPrompt: assembleSystemPrompt({
          // Segment ①: an authored persona (persona.md, def.persona) overrides the engine identity,
          // re-read per turn like AGENTS.md so edits go live; options.base still wins for full control.
          base: options.base ?? piBasePrompt({ tools, persona: def.persona }),
          // ② project context: AGENTS.md files (agentDir + cwd-ancestor walk) via loadProjectContextFiles.
          contextFiles: def.contextFiles,
          skills: def.skills,
          cwd: env.cwd,
        }),
        skills: def.skills,
      };
    },
    tools,
    sessions: options.sessions,
    env,
    lease: options.lease,
  });
  return { agent, definition };
}
