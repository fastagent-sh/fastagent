/**
 * Agent assembly (configuration-time): the engine assets (tools, prompt) plus the reusable ladder
 * that puts a pi agent together.
 *
 *   L2  createPiAgentFromDefinition(dir, options)   — load a definition directory, assemble, then L1.
 *   L1  createPiAgent(options)                       — assemble from typed parts (the canonical ctor).
 *   L0  createPiAgentFromSession({ sessionFactory }) — in invoke-session.ts (the turn mechanism).
 *
 * Above L2 sits the agent opener createPiAgentFromDir (open.ts), which both `dev` and
 * `start` drive. Each rung calls the one below; options narrow as you go up (L2 owns systemPrompt/skills —
 * they come from the definition; the openers own model/tools — from config resolution).
 */
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv, Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import type { Agent } from "../../agent.ts";
import {
  CODING_TOOL_NAMES,
  type CodingToolName,
  type FastagentConfig,
  defaultAuthPath,
  resolveModel,
} from "./config.ts";
import { resolveSecretsDir } from "../../paths.ts";
import { type LoadedDefinition, loadAgentDefinition, loadExtensionPaths } from "./definition.ts";
import { reportFindingsIfChanged } from "./report.ts";
import type { ModuleLoadFailure } from "../../loader.ts";
import {
  type DefineToolOptions,
  type ToolCollision,
  isDeferredTool,
  loadTools,
  mergeDiscoveredTools,
  type MountedTool,
} from "./tool.ts";
import { withSearchTool } from "./search-tools.ts";
import { type PiAgentSessionFactory, createPiAgentFromSession } from "./invoke-session.ts";
import { piAgentSessionFactory } from "./agent-session-factory.ts";
import { type AnyModel, DEFAULT_THINKING_LEVEL, createPiModelRuntime } from "./models.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type PiSessionRecordStore, piInMemorySessionRecordStore } from "./session-store.ts";
import { type Lease, type SessionObserver, inProcessLease } from "./turn-kit.ts";

// ── §1 tools ─────────────────────────────────────────────────────────────────
//
// The full pi toolset is the default for fidelity: authors vibe in local pi with it, so serving with
// fewer tools is behavior drift. A directory agent can narrow with `codingTools: [names]` or opt out
// with `codingTools: false`; L1/L2 library callers can pass a restricted `tools` list directly.
//
// They are pi-coding-agent's, the same package everything else here comes from (definition.ts,
// models.ts, the session runtime). pi-agent-core ships four look-alikes that reach the machine through
// the per-turn {@link ExecutionEnv} instead of `node:fs`, and those were used here for a while to keep
// `env` the single seam a sandbox adapter would implement.
//
// That seam was worth naming and is not worth keeping: `env` never isolated anything on its own —
// author-written `tools/` import whatever they like, which the docs say plainly — so it narrowed a
// blast radius rather than closing it, and sandboxing is an explicit non-goal today. The bill was
// concrete: a 167-line parity suite asserting the two families stay identical, and a hand-injected
// image pipeline because core's `read` has none. Both are gone with the swap. `grep`/`find`/`ls` live
// on this side too and are now reachable — mounting them is a separate decision about the default
// surface, not something this change makes. When a real sandbox arrives it will tell us where the seam
// belongs; a guess that costs this much every day is not a down payment.
//
// `chat` is unaffected: it takes these NAMES only and lets pi's own runtime rebuild the tools it
// renders (see session-builder.ts).

/** pi's default coding toolset (read/bash/edit/write), rooted at the workspace it operates in. */
export function piDefaultTools(cwd: string): MountedTool[] {
  return createCodingTools(cwd);
}

export interface ResolvedCodingTools {
  tools: MountedTool[];
  names: CodingToolName[];
}

/** Resolve the config's one coding-tool policy. Every directory consumer uses this result rather than
 *  re-interpreting undefined/true/false/arrays independently. */
export function resolveCodingTools(config: FastagentConfig, cwd: string): ResolvedCodingTools {
  const requested = config.codingTools;
  const enabled =
    requested === false
      ? new Set<CodingToolName>()
      : new Set<CodingToolName>(Array.isArray(requested) ? requested : CODING_TOOL_NAMES);
  const tools = piDefaultTools(cwd).filter((tool) => enabled.has(tool.name as CodingToolName));
  return { tools, names: tools.map((tool) => tool.name as CodingToolName) };
}

/** Which built-in coding capabilities a mounted set provides, read by NAME — the only observable. */
function codingToolNamesIn(mounted: readonly MountedTool[]): CodingToolName[] {
  return CODING_TOOL_NAMES.filter((name) => mounted.some((tool) => tool.name === name));
}

/**
 * Built-in coding tools this definition turned off, MINUS any name an authored tool has taken.
 *
 * pi's denylist matches by name, so excluding a name an author reused would delete their tool rather
 * than pi's — and with the built-in disabled, that name is theirs to use (see docs/configuration.md).
 */
export function disabledBuiltinNames(
  codingToolNames: readonly CodingToolName[],
  mounted: readonly MountedTool[],
): CodingToolName[] {
  const authored = new Set(mounted.map((tool) => tool.name));
  return CODING_TOOL_NAMES.filter((name) => !codingToolNames.includes(name) && !authored.has(name));
}

/** `config.tools` semantics: extra tools APPENDED after enabled pi coding tools, never replacing them. */
export function resolveTools(config: FastagentConfig, cwd: string): MountedTool[] {
  const coding = resolveCodingTools(config, cwd).tools;
  return config.tools ? [...coding, ...config.tools] : coding;
}

/**
 * The full tool set an agent mounts: enabled pi coding tools + `config.tools` + discovered `tools/` (deduped,
 * existing win), plus the non-default tool names and collisions to report. One source for the
 * dev/start openers AND `fastagent tool`, so they all mount exactly the same set.
 */
export async function resolveAgentTools(
  config: FastagentConfig,
  agentDir: string,
  cwd: string,
): Promise<{
  tools: MountedTool[];
  codingToolNames: CodingToolName[];
  toolNames: string[];
  /** Tools registered but not initially active (defineTool `deferred: true`) — discovered/activated
   *  via the built-in `search_tools` loader. Surfaced so the operator can see deferral took effect. */
  deferredToolNames: string[];
  toolCollisions: ToolCollision[];
  toolFailures: ModuleLoadFailure[];
}> {
  // Discovered `tools/` come from `agentDir` (the agent's own surface); the default coding tools are
  // rooted at `cwd`, the WORKSPACE — the project the agent works on, which is where an author expects
  // `read`/`bash` to land, and which is not always the definition directory.
  const discovered = await loadTools(agentDir);
  const coding = resolveCodingTools(config, cwd);
  const configured = config.tools ? [...coding.tools, ...config.tools] : coding.tools;
  const merged = mergeDiscoveredTools(configured, discovered.tools);
  // The built-in `search_tools` loader mounts here — the one place the agent's full tool set is
  // computed — so `dev`/`start`/`info`/`fastagent tool` all see the same surface (idempotent; an
  // agent-defined search_tools wins).
  const tools = withSearchTool(merged.tools);
  // Builtin = a search_tools that was ABSENT before withSearchTool (a reference compare would misfire
  // on the deferred-authored-loader case, where withSearchTool returns a new array without adding one).
  const builtinLoaderMounted =
    !merged.tools.some((t) => t.name === "search_tools") && tools.some((t) => t.name === "search_tools");
  const toolCollisions = [...discovered.collisions, ...merged.collisions];
  // `toolNames` is the AUTHOR's active-by-default surface (config.tools + tools/): exclude ENABLED pi
  // coding tools, the builtin loader (like wake, a builtin gets its own report line, not an anonymous
  // slot in the author's list — an author-DEFINED search_tools still shows), and deferred tools —
  // each name lives in exactly ONE report slot, and deferred names live in `deferredToolNames`. When
  // coding tools are disabled, an authored `read`/`bash`/`edit`/`write` is ordinary author surface.
  const defaultNames = new Set<string>(coding.names);
  const toolNames = tools
    .filter(
      (t) => !defaultNames.has(t.name) && !isDeferredTool(t) && !(builtinLoaderMounted && t.name === "search_tools"),
    )
    .map((t) => t.name);
  return {
    tools,
    codingToolNames: coding.names,
    toolNames,
    deferredToolNames: tools.filter(isDeferredTool).map((t) => t.name),
    toolCollisions,
    toolFailures: discovered.failures,
  };
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
export function piBasePrompt(
  options: { tools?: MountedTool[]; persona?: string; codingToolNames?: readonly CodingToolName[] } = {},
): string {
  const mounted = options.tools ?? [];
  // Deferred tools stay OUT of the list: their schemas are not in the request until activated, so
  // naming them here would invite calls to tools that don't exist yet; discovery is search_tools' job
  // (which IS listed — it's active). Computed from the static mounted set, so the prompt — the cached
  // context prefix — does not change when a tool is activated mid-session.
  const tools = mounted.filter((t) => !isDeferredTool(t));
  const deferredCount = mounted.length - tools.length;
  const toolsList =
    tools.length > 0 ? tools.map((t) => `- ${t.name}: ${(t.description ?? "").split("\n")[0]}`).join("\n") : "(none)";
  // Segment ① identity: an authored persona (persona.md) replaces the default engine identity line
  // (core.md §11), keeping the tools list + guidelines below. Preserve pi's coding identity only for
  // the full coding surface; a partial/empty surface must not claim machine capabilities it lacks.
  const codingNames = options.codingToolNames ?? codingToolNamesIn(mounted);
  const fullCodingSurface = CODING_TOOL_NAMES.every((name) => codingNames.includes(name));
  const identity =
    options.persona?.trim() ||
    (fullCodingSurface
      ? "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files."
      : "You are an AI assistant operating inside pi, an agent harness. Help users using only the tools and context available to you.");
  const deferredNote =
    deferredCount > 0
      ? `\n\n${deferredCount} additional tool(s) are registered but inactive — use search_tools to discover and activate them before concluding a capability is missing.`
      : "";
  return `${identity}

Available tools:
${toolsList}${deferredNote}

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
  /** A pre-built collection, used verbatim. The DIRECTORY rungs pass one so the agent's own
   *  models.json is in scope (see createPiModelRuntime); building it is async, which is why it
   *  happens in the caller — L1 has no directory, so it keeps the synchronous built-ins path. */
  /** The model registry to run on. The directory rung passes one built from the agent's models.json. */
  models?: ModelRuntime;
  systemPrompt?: string | (() => string);
  tools?: MountedTool[];
  skills?: Skill[];
  /** Per-invoke prompt+skills source (see {@link PiAgentSessionFactoryOptions.live}); supersedes the
   *  two above. */
  live?: () => Promise<{ systemPrompt?: string; skills?: Skill[] }>;
  /** Where conversations live. Defaults to in-memory; the directory opener passes a durable store. */
  sessions?: PiSessionRecordStore;
  /** Where pi reads its own settings; see {@link PiAgentSessionFactoryOptions.agentDir}. */
  agentDir?: string;
  /** The definition's extension entry points; see {@link PiAgentSessionFactoryOptions.extensionPaths}. */
  extensionPaths?: string[];
  /** Disabled built-ins; see {@link PiAgentSessionFactoryOptions.excludedToolNames}. */
  excludedToolNames?: readonly string[];
  env?: ExecutionEnv;
  /** The WORKSPACE: where tools operate, what the model is told its working directory is, and what
   *  session records are keyed to. Defaults to the env's root, which is the same thing at L1 — the
   *  two only diverge when a caller names a workspace AND hands a separately-rooted env, and then
   *  every one of those three must follow the workspace, not the loader. */
  cwd?: string;
  lease?: Lease;
  observer?: SessionObserver;
  onAssembly?: OnAssembly;
}): Agent {
  const env = opts.env ?? new NodeExecutionEnv({ cwd: process.cwd() });
  const cwd = opts.cwd ?? env.cwd;
  // Materialized here (not defaulted inside the L0) so the exposed parts carry the SAME lease
  // instance the agent runs under — boundary mutations must contend on it.
  const lease = opts.lease ?? inProcessLease();
  const sessions = opts.sessions ?? piInMemorySessionRecordStore({ cwd });
  // The model and its runtime resolve on FIRST USE: building a ModelRuntime is async while
  // assembling an agent is not, so the credential read belongs on the first turn rather than in the
  // caller's constructor. Memoized by the factory, and shared with the control plane below so a
  // boundary mutation validates against the registry the runs actually use.
  let engine: Promise<{ modelRuntime: ModelRuntime; model: AnyModel }> | undefined;
  const resolveEngine = () => {
    engine ??= (async () => {
      // The caller's registry when there is one — the directory rung builds it from the agent's own
      // models.json, so a custom endpoint declared there is the one a turn resolves against.
      const modelRuntime = opts.models ?? (await createPiModelRuntime({ authPath: opts.authPath }));
      // ModelRuntime registers providers by config record, so an injected Provider INSTANCE (a
      // gateway, a self-hosted endpoint, a test fake) goes in through its native seam.
      for (const provider of opts.providers ?? []) modelRuntime.registerNativeProvider(provider);
      return { modelRuntime, model: resolveModel(modelRuntime, opts.model) };
    })();
    return engine;
  };
  const sessionFactory = piAgentSessionFactory({
    sessions,
    engine: resolveEngine,
    thinkingLevel: opts.thinkingLevel,
    tools: opts.tools,
    systemPrompt: opts.systemPrompt,
    skills: opts.skills,
    live: opts.live,
    cwd,
    ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
    ...(opts.extensionPaths ? { extensionPaths: opts.extensionPaths } : {}),
    ...(opts.excludedToolNames?.length ? { excludedToolNames: opts.excludedToolNames } : {}),
    env,
  });
  opts.onAssembly?.({
    lease,
    sessionFactory,
    // The control plane needs the registry and the configured pair as VALUES, and both only exist
    // after the first credential read. Asking for them lazily keeps assembly synchronous without
    // making the hub wait on a runtime it may never need (a control-less deployment never calls it).
    engine: resolveEngine,
    thinkingLevel: opts.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
  });
  return createPiAgentFromSession({ lease, observer: opts.observer, sessionFactory });
}

/**
 * INTERNAL seam (workspace ↔ assembly): hands the hub-wiring consumer the assembly's live parts —
 * the SAME session factory and lease the agent runs with, plus the model registry behind a thunk —
 * so boundary mutations (session-control.ts) contend on the real lease and validate against the real
 * registry. Called synchronously, exactly once, before the agent is returned. Not public surface.
 */
export type PiAssemblyParts = {
  lease: Lease;
  sessionFactory: PiAgentSessionFactory;
  /** The registry and configured model, resolved on first use (a credential read is async). */
  engine: () => Promise<{ modelRuntime: ModelRuntime; model: AnyModel }>;
  /** The configured reasoning effort — the other half of the pair a session without overrides runs on. */
  thinkingLevel: ThinkingLevel;
};

type OnAssembly = (parts: PiAssemblyParts) => void;

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
   * The system prompt itself — no engine base and no wrapping (unlike the directory path, which
   * assembles the engine base + AGENTS.md as segment ② + persona.md as segment ①). A plain string or
   * a factory re-evaluated per invoke. When {@link skills} are mounted their listing is appended.
   *
   * Not byte-for-byte verbatim: pi appends its own `Current working directory:` line to whatever
   * prompt it is given. What this rung guarantees is that no engine IDENTITY is imposed — a
   * hand-built agent is not told it is a coding assistant.
   */
  instructions?: string | (() => string);
  /** The tool set to mount. `FastagentTool` (AgentTool plus the optional `deferred` marker, see
   *  {@link DefineToolOptions}) widens into {@link MountedTool}, which additionally admits pi's default
   *  coding tools — they read the turn's ExecutionEnv as a fifth `execute` parameter. */
  tools?: MountedTool[];
  skills?: Skill[];
  // ── Tier 2: injectable ports ───────────────────────────────────────────────
  /**
   * Extra providers registered on top of the built-ins — your own gateway / self-hosted endpoint /
   * test fake — selected by the `model` spec's provider id. Built-ins cover the rest; static keys
   * still come from the {@link authPath} credentials file (fastagent login) or env, not from here.
   */
  providers?: Provider[];
  /**
   * Credentials file for stored OAuth/API-key auth. Defaults to `~/.fastagent/.secrets/auth.json`; the
   * directory opener passes the project-level `<root>/.secrets/auth.json` instead. Env vars are still
   * consulted when a provider is absent from the file (resolution order is upstream-owned).
   */
  authPath?: string;
  /** Session persistence. Defaults to in-memory; inject piSessionRecordStore for restart-surviving
   *  continuity. */
  sessions?: PiSessionRecordStore;
  /** Filesystem/process environment, handed to tools that read one as the turn's context. Defaults to
   *  a local NodeExecutionEnv at `process.cwd()`. At THIS rung nothing else consumes it: L1 loads no
   *  definition. It does NOT constrain the default coding tools (pi's own, rooted at the workspace they
   *  were built for) or author-written `tools/`, which are code and can import anything. Not a
   *  sandbox — see {@link createPiAgentFromDefinition} for the rung where it also reads the
   *  definition. */
  env?: ExecutionEnv;
  /** Single-writer lease. Defaults to in-process fail-fast inProcessLease(). */
  lease?: Lease;
  /** Observation-plane tap (session control): every rich session event of every run. Wire the one
   *  returned by `createPiSessionControl` to serve `state`/`entries`/`events` for this agent. */
  observer?: SessionObserver;
}

/** L1: assemble from typed parts. */
export function createPiAgent(options: CreatePiAgentOptions): Agent {
  return buildPiAgent({
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    providers: options.providers,
    authPath: options.authPath,
    systemPrompt: instructionsPrompt(options.instructions, options.skills),
    // Deferred tools need their loader on every rung (idempotent; the caller's own search_tools wins).
    tools: options.tools ? withSearchTool(options.tools) : options.tools,
    skills: options.skills,
    sessions: options.sessions,
    env: options.env,
    lease: options.lease,
    observer: options.observer,
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
  /** Override tools. Defaults to {@link piDefaultTools} (lock down with a custom list). An authored
   *  `FastagentTool[]` (AgentTool plus the optional `deferred` marker) widens into {@link MountedTool}. */
  tools?: MountedTool[];
  /** INTERNAL directory-opener fact: which mounted tools are pi's coding tools. Keeps prompt identity
   *  and the disabled-built-in exclusion tied to the resolver instead of inferring semantics from
   *  authored names. */
  codingToolNames?: readonly CodingToolName[];
  /**
   * The agent's working directory: where the default tools operate AND whose ancestors are walked for
   * ② project context (AGENTS.md). Defaults to `dir`. Set it to the enclosing repo so a coding agent
   * whose definition lives in `dir` operates on — and reads the AGENTS.md of — that repo (core.md
   * scenario grid); that is what the CLI's opener does with the workspace.
   */
  cwd?: string;
  /** Extra providers registered on top of the built-ins (your own gateway / self-hosted endpoint). */
  providers?: Provider[];
  /**
   * Credentials file (see {@link CreatePiAgentOptions.authPath}). Being dir-aware, this rung defaults
   * to the PROJECT-level `<dir>/.secrets/auth.json` (matching `fastagent dev`/`start` on the same
   * dir) — unlike the dir-less {@link createPiAgent}/{@link createPiModels}, which default global.
   */
  authPath?: string;
  sessions?: PiSessionRecordStore;
  /** Filesystem/process environment; see {@link CreatePiAgentOptions.env}. At THIS rung it is what
   *  persona.md and skills/ are read through. Two surfaces stay
   *  OUTSIDE it — ② project context (pi's loadProjectContextFiles uses node fs directly; see
   *  definition.ts) and author-written `tools/`, which are code and can import anything. Injecting an
   *  env narrows the blast radius rather than closing it. */
  env?: ExecutionEnv;
  lease?: Lease;
  /** Observation-plane tap; see {@link CreatePiAgentOptions.observer}. */
  observer?: SessionObserver;
  /** INTERNAL seam for hub wiring; see {@link OnAssembly}. */
  onAssembly?: OnAssembly;
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
  // `cwd`, not `env.cwd`, for the same reason as the tools below: `cwd` is the run root whose
  // ancestors carry ② project context. Reading it off the env pointed the AGENTS.md walk at the
  // loader's directory whenever a caller supplied both.
  const definition = await loadAgentDefinition(dir, { cwd, env });
  // Deferred tools need their loader on every rung (idempotent — the workspace opener already applied
  // it; a caller's own search_tools wins).
  // `cwd`, not `env.cwd`: the workspace is what this option MEANS, and a caller may hand a custom env
  // for definition loading whose root is a different directory. Taking it off the env would silently
  // point read/bash/edit/write at the loader's directory.
  const tools = withSearchTool(options.tools ?? piDefaultTools(cwd));
  // An explicit `tools` list is the caller stating the whole surface, so the coding capabilities are
  // whichever built-in NAMES appear in it — not none. A caller passing `piDefaultTools()` gets the
  // identity that matches what they mounted, rather than the capability-neutral one. Name-based,
  // exactly like the exclusion below, and for the same reason: the name is the only thing either
  // side can observe. `codingTools` stays a definition property — the directory opener passes the
  // resolved set explicitly.
  const codingToolNames =
    options.codingToolNames ??
    (options.tools === undefined ? [...CODING_TOOL_NAMES] : codingToolNamesIn(options.tools));
  // Boot findings go through the SAME memoized reporter every later reader uses (report.ts, keyed by
  // the resolved dir): announced once here, and re-announced by a turn or by the control plane's
  // command list only when the set CHANGES — a runtime-written bad skill surfaces the moment it
  // appears, a static one does not spam. Log dedup, not session state (stateless invoke holds).
  reportFindingsIfChanged(definition.dir, definition);
  // Dir-aware default: the same secrets-dir-derived file the opener uses for this dir (the opener
  // passes an explicit authPath, so this only affects direct L2 callers).
  const authPath = options.authPath ?? defaultAuthPath(resolveSecretsDir(dir));
  const agent = buildPiAgent({
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    // THE directory rung's model surface: built-ins + the agent's own models.json (custom endpoints,
    // which are definition data and travel with the artifact) + any injected Provider instance. This
    // is what makes `dev`/`start`/`invoke` and an embedded L2 caller resolve the same specs.
    models: await createPiModelRuntime({ agentDir: dir, authPath, providers: options.providers }),
    authPath,
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
      const def = await loadAgentDefinition(dir, { cwd, env });
      reportFindingsIfChanged(def.dir, def);
      return {
        systemPrompt: assembleSystemPrompt({
          // Segment ①: an authored persona (persona.md, def.persona) overrides the engine identity,
          // re-read per turn like AGENTS.md so edits go live; options.base still wins for full control.
          base: options.base ?? piBasePrompt({ tools, persona: def.persona, codingToolNames }),
          // ② project context: AGENTS.md files (agentDir + cwd-ancestor walk) via loadProjectContextFiles.
          contextFiles: def.contextFiles,
          skills: def.skills,
          // The workspace, matching where the tools operate. Telling the model one directory while
          // `read`/`bash` resolve relative paths against another is a lie it cannot detect.
          cwd,
        }),
        skills: def.skills,
      };
    },
    tools,
    sessions: options.sessions,
    // Discovered so the serving assembly can WARN that it does not run them (and so the refusals
    // apply to the artifact either way) — `chat` is where they load. Boot-resolved: the set cannot
    // change without a restart, which is why this sits outside `live` above.
    extensionPaths: await loadExtensionPaths(dir, { cwd, env }),
    cwd,
    // The disabled built-ins, refused at the registry — see PiAgentSessionFactoryOptions. A name an
    // AUTHORED tool has taken is not excluded: with the built-in off, that name is the author's to
    // reuse (documented), and pi's denylist works on names, so excluding it would delete their tool.
    excludedToolNames: disabledBuiltinNames(codingToolNames, tools),
    env,
    lease: options.lease,
    observer: options.observer,
    onAssembly: options.onAssembly,
  });
  return { agent, definition };
}
