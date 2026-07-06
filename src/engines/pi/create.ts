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
import { join } from "node:path";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import type { AgentTool, ExecutionEnv, Skill } from "@earendil-works/pi-agent-core";
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

/**
 * Shared low-level wiring: resolve the model spec against the collection, default the K ports, build
 * the agent. Internal — the public rungs decide the systemPrompt (L1 from instructions, L2 from the
 * directory) and route through here.
 */
function buildPiAgent(opts: {
  model: string;
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
  /**
   * The system prompt — your agent's persona, the code-side equivalent of AGENTS.md. A plain string
   * or a factory re-evaluated per invoke. When {@link skills} are mounted their listing is appended.
   * No engine persona is prepended (that is a directory-fidelity concern of createPiAgentFromDefinition).
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
  /** Tool execution environment. Defaults to local NodeExecutionEnv (cwd); production injects a sandbox. */
  env?: ExecutionEnv;
  /** Single-writer lease. Defaults to in-process fail-fast inProcessLease(). */
  lease?: Lease;
}

/** L1: assemble from typed parts. */
export function createPiAgent(options: CreatePiAgentOptions): Agent {
  return buildPiAgent({
    model: options.model,
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
  /** Override the engine base prompt (segment ①). Defaults to piBasePrompt({tools}). */
  base?: string;
  /** Override tools. Defaults to piDefaultTools (lock down with a custom list). */
  tools?: AgentTool[];
  /** Extra providers registered on top of the built-ins (your own gateway / self-hosted endpoint). */
  providers?: Provider[];
  /**
   * Credentials file (see {@link CreatePiAgentOptions.authPath}). Being dir-aware, this rung defaults
   * to the PROJECT-level `<dir>/.fastagent/auth.json` (matching `fastagent dev`/`start` on the same
   * dir) — unlike the dir-less {@link createPiAgent}/{@link createPiModels}, which default global.
   */
  authPath?: string;
  sessions?: PiSessionStore;
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
  const env = options.env ?? new NodeExecutionEnv({ cwd: dir });
  // Boot-time load: fail-visibly at startup on a broken directory, and give callers the snapshot to
  // report (skills/diagnostics/collisions). Serving does NOT close over it — see `live` below.
  const definition = await loadAgentDefinition(dir, { env });
  // Findings the caller already reported at boot; `live` re-reports only when the set CHANGES — a
  // runtime-written bad skill surfaces the moment it appears, while a static finding does not spam
  // every turn's log. A log-dedup memo, not session state (stateless invoke holds).
  let reportedFindings = findingsSignature(definition);
  const tools = options.tools ?? piDefaultTools(env.cwd);
  const base = options.base ?? piBasePrompt({ tools });
  const agent = buildPiAgent({
    model: options.model,
    providers: options.providers,
    // Dir-aware default: the same state-root-derived file the opener uses for this dir (the opener
    // passes an explicit authPath, so this only affects direct L2 callers).
    authPath: options.authPath ?? defaultAuthPath(resolveStateRoot(dir)),
    // The directory is the agent, LIVE: re-read the definition on every invoke, so AGENTS.md/skills
    // edits (the author's, or the agent's own self-modification) take effect on the next turn with
    // no process restart — restarts are reserved for code (tools/channels/config, module cache).
    // One read yields prompt AND skills (they can never diverge), `date` is the turn's date, and the
    // fs cost is a few reads against a model call. Broken edits stay visible: a throw-class problem
    // (unreadable AGENTS.md) fails that turn's invoke, and the loader's NON-fatal findings (bad
    // SKILL.md frontmatter, name collisions — returned as data, not thrown) are warned the moment
    // the finding set changes (boot findings are the baseline) — a runtime-written bad skill must
    // not silently vanish from the agent, and a static one must not spam every turn's log. The
    // next good edit heals both.
    live: async () => {
      const def = await loadAgentDefinition(dir, { env });
      const sig = findingsSignature(def);
      if (sig !== reportedFindings) {
        reportedFindings = sig;
        reportDefinitionWarnings(def.collisions, def.diagnostics);
      }
      return {
        systemPrompt: assembleSystemPrompt({
          base,
          instructions: def.instructions,
          instructionsPath: def.instructions !== undefined ? join(def.dir, "AGENTS.md") : undefined,
          skills: def.skills,
          date: new Date().toISOString().slice(0, 10),
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
