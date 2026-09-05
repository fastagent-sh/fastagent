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
 *
 * Every rung assembles the same VALUE first — a {@link PiAssembly}: the lease, the session factory
 * and the engine thunk — and the agent is that value under the L0. The opener needs the value
 * itself (the control plane contends on the same lease and validates against the same registry), so
 * `assemblePiFromDefinition` hands it out and `createPiAgentFromDefinition` is it plus the L0.
 */
import type { ExecutionEnv, Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createCodingTools,
  createPowerShellTool,
  createReadOnlyTools,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import type { Agent } from "../../agent.ts";
import { type FastagentConfig, defaultAuthPath, resolveModel } from "./config.ts";
import { resolveSecretsDir } from "../../paths.ts";
import { type LoadedDefinition, loadAgentDefinition, loadExtensionPaths } from "./definition.ts";
import { reportFindingsIfChanged } from "./report.ts";
import type { ModuleLoadFailure } from "../../loader.ts";
import { type ToolCollision, isDeferredTool, loadTools, mergeDiscoveredTools, type MountedTool } from "./tool.ts";
import { withSearchTool } from "./search-tools.ts";
import { type PiAgentSessionFactory, createPiAgentFromSession } from "./invoke-session.ts";
import { piAgentSessionFactory } from "./agent-session-factory.ts";
import { type AnyModel, DEFAULT_THINKING_LEVEL, createPiModelRuntime } from "./models.ts";
import { type PiSessionRecordStore, piInMemorySessionRecordStore } from "./session-store.ts";
import { type Lease, type SessionObserver, inProcessLease } from "./turn-kit.ts";

// ── §1 tools ─────────────────────────────────────────────────────────────────
//
// A directory agent gets every pi coding tool. Restricting what those tools can reach belongs at the
// sandbox boundary, not in an allowlist that leaves authored tools unrestricted. L1/L2 library callers
// can still replace the coding defaults through `tools`; deferred tools may add `search_tools`.
//
// This is not a security boundary and no default here could be one: the built-in POST /invoke has no
// authentication, author-written `tools/` import whatever they like, and a WebSocket or Socket-Mode
// channel dials OUT, so no bind address constrains who can message the agent. Whoever can reach an
// agent can use everything it mounts — put it behind something that decides who may.
//
// All seven come from pi-coding-agent and reach the machine through `node:fs`, bypassing the per-turn
// {@link ExecutionEnv}. pi-agent-core ships env-routed look-alikes, but that seam narrows a blast
// radius rather than closing one (authored `tools/` ignore it), so a real sandbox must wrap the
// process instead.
//
// Chat receives the same tool objects through pi's `customTools` path; pi's builtin copies stay off.

/**
 * Every pi coding tool, in canonical order, rooted at the workspace it operates in.
 *
 * pi ships two overlapping groupings and neither is the whole set: `createCodingTools` is the four it
 * ACTIVATES for a terminal (read/bash/edit/write, no searching), `createReadOnlyTools` is
 * read/grep/find/ls. `read` is in both; a directory agent mounts their union.
 */
export const CODING_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

export function piAllCodingTools(cwd: string): MountedTool[] {
  const mutating = createCodingTools(cwd).filter((tool) => tool.name !== "read");
  return [...createReadOnlyTools(cwd), ...mutating];
}

/**
 * Every tool an `AgentSession` registers on its own, whether or not a directory agent mounts it.
 *
 * Wider than {@link CODING_TOOL_NAMES} on purpose: pi 0.84.3 added `powershell`, which the session
 * registers regardless of the tools we pass. A name absent from THIS list is a name never excluded,
 * and an excluded name is the only thing that cannot be activated — so leaving it out would let
 * `tools: [read]` keep a reachable shell.
 */
function piRegisteredToolNames(cwd: string): string[] {
  return [
    ...createReadOnlyTools(cwd).map((tool) => tool.name),
    ...createCodingTools(cwd).map((tool) => tool.name),
    createPowerShellTool(cwd).name,
  ];
}

/** Built-ins omitted by an explicit lower-level tool list. A reused name stays mounted. */
function omittedBuiltinNames(mounted: readonly MountedTool[], cwd: string): string[] {
  const mountedNames = new Set(mounted.map((tool) => tool.name));
  return [...new Set(piRegisteredToolNames(cwd))].filter((name) => !mountedNames.has(name));
}

/**
 * The full directory-agent tool set: all pi coding tools + `config.tools` + discovered `tools/`
 * (deduped, existing win), plus the authored names and collisions to report. One source for the
 * dev/start openers AND `fastagent tool`, so they all mount exactly the same set.
 */
export async function resolveAgentTools(
  config: FastagentConfig,
  agentDir: string,
  cwd: string,
): Promise<{
  tools: MountedTool[];
  toolNames: string[];
  /** Tools registered but not initially active (defineTool `deferred: true`) — discovered/activated
   *  via the built-in `search_tools` loader. Surfaced so the operator can see deferral took effect. */
  deferredToolNames: string[];
  toolCollisions: ToolCollision[];
  toolFailures: ModuleLoadFailure[];
}> {
  // Discovered `tools/` come from `agentDir` (the agent's own surface); the coding tools are
  // rooted at `cwd`, the WORKSPACE — the project the agent works on, which is where an author expects
  // `read`/`bash` to land, and which is not always the definition directory.
  const discovered = await loadTools(agentDir);
  const configured = piAllCodingTools(cwd);
  const configuredNames = new Set(configured.map((tool) => tool.name));
  const configuredCollisions: ToolCollision[] = [];
  for (const tool of config.tools ?? []) {
    if (configuredNames.has(tool.name)) {
      configuredCollisions.push({ name: tool.name, source: "config.tools" });
      continue;
    }
    configuredNames.add(tool.name);
    configured.push(tool);
  }
  const merged = mergeDiscoveredTools(configured, discovered.tools);
  // The built-in `search_tools` loader mounts here — the one place the agent's full tool set is
  // computed — so `dev`/`start`/`info`/`fastagent tool` all see the same surface (idempotent; an
  // agent-defined search_tools wins).
  const tools = withSearchTool(merged.tools);
  // Builtin = a search_tools that was ABSENT before withSearchTool (a reference compare would misfire
  // on the deferred-authored-loader case, where withSearchTool returns a new array without adding one).
  const builtinLoaderMounted =
    !merged.tools.some((t) => t.name === "search_tools") && tools.some((t) => t.name === "search_tools");
  const toolCollisions = [...discovered.collisions, ...configuredCollisions, ...merged.collisions];
  // `toolNames` is the AUTHOR's active-by-default surface (config.tools + tools/): exclude pi coding
  // tools, the builtin loader (like wake, a builtin gets its own report line, not an anonymous slot in
  // the author's list — an author-DEFINED search_tools still shows), and deferred tools. Each name
  // lives in exactly ONE report slot, and deferred names live in `deferredToolNames`.
  const defaultNames = new Set<string>(CODING_TOOL_NAMES);
  const toolNames = tools
    .filter(
      (t) => !defaultNames.has(t.name) && !isDeferredTool(t) && !(builtinLoaderMounted && t.name === "search_tools"),
    )
    .map((t) => t.name);
  return {
    tools,
    toolNames,
    deferredToolNames: tools.filter(isDeferredTool).map((t) => t.name),
    toolCollisions,
    toolFailures: discovered.failures,
  };
}

// Fastagent owns identity and project context; Pi appends skills and cwd for both serving and chat.

/**
 * The pi engine's base prompt (segment ①), mirroring pi-coding-agent's default path with two
 * deviations: the pi-TUI docs section is dropped (those paths don't exist in deployments), and the
 * tool list is generated from the actually-mounted tools (base and toolset must agree). An authored
 * `persona` (from persona.md) replaces the default identity line, keeping the tools list + guidelines.
 */
export function piBasePrompt(options: { tools?: MountedTool[]; persona?: string } = {}): string {
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
  // (core.md §2), keeping the tools list + guidelines below. Preserve pi's coding identity only for
  // the full coding surface; a partial/empty surface must not claim machine capabilities it lacks.
  // The four this sentence NAMES — reading, executing, editing, writing. Searching is not part of the
  // claim, so requiring it would demote an agent that can do everything the identity says it can.
  const mountedNames = new Set(mounted.map((tool) => tool.name));
  const fullCodingSurface = (["read", "bash", "edit", "write"] as const).every((name) => mountedNames.has(name));
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
  return prompt;
}

// ── §3 the reusable assembly ladder: L1 / L2 ────────────────────────────────

/**
 * The assembly, as a value: what every rung builds and what the agent runs on. The opener hands it to
 * the control plane too — boundary mutations contend on the SAME lease and validate against the SAME
 * registry the runs use, which is only true if there is one of each to hand over.
 */
export interface PiAssembly {
  lease: Lease;
  sessionFactory: PiAgentSessionFactory;
  /** The registry and configured model, resolved on first use (a credential read is async). */
  engine: () => Promise<{ modelRuntime: ModelRuntime; model: AnyModel }>;
  /** The configured reasoning effort — the other half of the pair a session without overrides runs on. */
  thinkingLevel: ThinkingLevel;
}

/**
 * Shared low-level wiring: resolve the model spec against the collection, default the K ports, build
 * the parts. Internal — the public rungs decide the systemPrompt (L1 from instructions, L2 from the
 * directory) and route through here.
 */
function assemblePi(opts: {
  model: string;
  thinkingLevel?: ThinkingLevel;
  providers?: Provider[];
  authPath?: string;
  /** The model registry to run on, used verbatim. The DIRECTORY rung passes one so the agent's own
   *  models.json is in scope (see createPiModelRuntime); building it is async, which is why it
   *  happens in the caller — L1 has no directory, so it keeps the synchronous built-ins path. */
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
  env?: ExecutionEnv;
  /** The WORKSPACE: where tools operate, what the model is told its working directory is, and what
   *  session records are keyed to. Defaults to the env's root, which is the same thing at L1 — the
   *  two only diverge when a caller names a workspace AND hands a separately-rooted env, and then
   *  every one of those three must follow the workspace, not the loader. */
  cwd?: string;
  lease?: Lease;
}): PiAssembly {
  const cwd = opts.cwd ?? opts.env?.cwd ?? process.cwd();
  // Materialized here (not defaulted inside the L0) so the value carries the SAME lease instance the
  // agent runs under — boundary mutations must contend on it.
  const lease = opts.lease ?? inProcessLease();
  const sessions = opts.sessions ?? piInMemorySessionRecordStore({ cwd });
  // The model and its runtime resolve on FIRST USE: building a ModelRuntime is async while
  // assembling an agent is not, so the credential read belongs on the first turn rather than in the
  // caller's constructor. Memoized, and shared with the control plane so a boundary mutation
  // validates against the registry the runs actually use.
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
    // `noTools: "builtin"` leaves pi's built-ins in the registry; a lower-level replacement must also
    // deny every omitted coding name so a loader cannot reactivate one later.
    excludedToolNames: omittedBuiltinNames(opts.tools ?? [], cwd),
  });
  return {
    lease,
    sessionFactory,
    engine: resolveEngine,
    thinkingLevel: opts.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
  };
}

/** The agent an assembly runs as: the L0 over its lease and session factory. */
export function agentOf(assembly: PiAssembly, observer?: SessionObserver): Agent {
  return createPiAgentFromSession({ lease: assembly.lease, observer, sessionFactory: assembly.sessionFactory });
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
   * a factory re-evaluated per invoke. Pi appends the skills listing when read is active.
   *
   * Not byte-for-byte verbatim: pi appends its own `Current working directory:` line to whatever
   * prompt it is given. What this rung guarantees is that no engine IDENTITY is imposed — a
   * hand-built agent is not told it is a coding assistant.
   */
  instructions?: string | (() => string);
  /** The tool set to mount: authored tools or pi's cwd-bound coding tools, both AgentTool. */
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
  /** Supplies the working directory at L1 (default: process.cwd()), which loads no definition.
   *  At L2 it also reads persona.md and skills/.
   *  Tools and project-context discovery use the local process directly; this is not a sandbox. */
  env?: ExecutionEnv;
  /** Single-writer lease. Defaults to in-process fail-fast inProcessLease(). */
  lease?: Lease;
  /** Observation-plane tap (session control): every rich session event of every run. Wire the one
   *  returned by `createPiSessionControl` to serve `state`/`entries`/`events` for this agent. */
  observer?: SessionObserver;
}

/** L1: assemble from typed parts. */
export function createPiAgent(options: CreatePiAgentOptions): Agent {
  return agentOf(
    assemblePi({
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      providers: options.providers,
      authPath: options.authPath,
      systemPrompt: options.instructions,
      // Deferred tools need their loader on every rung (idempotent; the caller's own search_tools wins).
      tools: options.tools ? withSearchTool(options.tools) : options.tools,
      skills: options.skills,
      sessions: options.sessions,
      env: options.env,
      lease: options.lease,
    }),
    options.observer,
  );
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
  /** Override tools. Defaults to {@link piAllCodingTools} (lock down with a custom list). An authored
   *  `FastagentTool[]` (AgentTool plus the optional `deferred` marker) widens into {@link MountedTool}. */
  tools?: MountedTool[];
  /**
   * The agent's working directory: where the coding tools operate AND whose ancestors are walked for
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
  /** Filesystem/process environment; see {@link CreatePiAgentOptions.env}. At THIS rung it reads
   *  persona.md and skills/. The seven coding tools, ② project context (pi's
   *  loadProjectContextFiles uses node fs directly), and author-written `tools/` stay outside it.
   *  Injecting an env narrows the blast radius rather than closing it. */
  env?: ExecutionEnv;
  lease?: Lease;
  /** Observation-plane tap; see {@link CreatePiAgentOptions.observer}. */
  observer?: SessionObserver;
}

/**
 * L2, as the value: load the directory (base + AGENTS.md + skills + env) and assemble. Returns the
 * definition so callers can surface diagnostics/collisions. The opener consumes this form because
 * the control plane needs the parts; {@link createPiAgentFromDefinition} is it plus the L0.
 */
export async function assemblePiFromDefinition(
  dir: string,
  options: Omit<CreatePiAgentFromDefinitionOptions, "observer">,
): Promise<{ assembly: PiAssembly; definition: LoadedDefinition }> {
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
  // point the coding tools at the loader's directory.
  const tools = withSearchTool(options.tools ?? piAllCodingTools(cwd));
  // Boot findings go through the SAME memoized reporter every later reader uses (report.ts, keyed by
  // the resolved dir): announced once here, and re-announced by a turn or by the control plane's
  // command list only when the set CHANGES — a runtime-written bad skill surfaces the moment it
  // appears, a static one does not spam. Log dedup, not session state (stateless invoke holds).
  reportFindingsIfChanged(definition.dir, definition);
  // Dir-aware default: the same secrets-dir-derived file the opener uses for this dir (the opener
  // passes an explicit authPath, so this only affects direct L2 callers).
  const authPath = options.authPath ?? defaultAuthPath(resolveSecretsDir(dir));
  const assembly = assemblePi({
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
          base: options.base ?? piBasePrompt({ tools, persona: def.persona }),
          // ② project context: AGENTS.md files (agentDir + cwd-ancestor walk) via loadProjectContextFiles.
          contextFiles: def.contextFiles,
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
    env,
    lease: options.lease,
  });
  return { assembly, definition };
}

/** L2: "point at a directory → agent": {@link assemblePiFromDefinition} under the L0. */
export async function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: LoadedDefinition }> {
  const { assembly, definition } = await assemblePiFromDefinition(dir, options);
  return { agent: agentOf(assembly, options.observer), definition };
}
