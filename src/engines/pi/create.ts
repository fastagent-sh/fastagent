/**
 * Agent assembly (configuration-time): the engine assets (tools, prompt) plus the reusable ladder that puts a pi agent
 * together.
 */
import { toUSVString } from "node:util";
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
import { GLOBAL_AUTH_PATH } from "./auth.ts";
import { isAgentcoreRuntime, isDeployedWorkspace, resolveSecretsDir } from "../../paths.ts";
import { type LoadedDefinition, loadAgentDefinition, loadExtensionPaths } from "./definition.ts";
import { reportFindingsIfChanged } from "./report.ts";
import type { ModuleLoadFailure } from "../../loader.ts";
import {
  type FastagentTool,
  type ToolCollision,
  isDeferredTool,
  loadTools,
  mergeDiscoveredTools,
  type MountedTool,
} from "./tool.ts";
import { type DeclaredSecret, readSecretDeclaration } from "../../declared-secrets.ts";
import { withSearchTool } from "./search-tools.ts";
import { type PiAgentSessionFactory, createPiAgentFromSession } from "./invoke-session.ts";
import { type PiAgentSessionFactoryOptions, piAgentSessionFactory } from "./agent-session-factory.ts";
import { type AnyModel, DEFAULT_THINKING_LEVEL, createPiModelRuntime } from "./models.ts";
import { type PiSessionRecordStore, piInMemorySessionRecordStore } from "./session-store.ts";
import { type Lease, type SessionObserver, inProcessLease } from "./turn-kit.ts";

// ── §1 tools ─────────────────────────────────────────────────────────────────
//
// A directory agent gets every pi coding tool.

/**
 * Every pi coding tool, in canonical order, rooted at the workspace it operates in. pi ships two overlapping groupings
 * and neither is the whole set.
 */
export const CODING_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

export function piAllCodingTools(cwd: string): MountedTool[] {
  const mutating = createCodingTools(cwd, {
    bash: {
      spawnHook(context) {
        const { env } = context;
        const id = env.PI_SESSION_ID;
        delete env.PI_SESSION_ID_ENCODING;
        // OS environment strings cannot preserve NUL or unpaired UTF-16 surrogates.
        if (id !== undefined && (id.includes("\u0000") || toUSVString(id) !== id)) {
          env.PI_SESSION_ID = JSON.stringify(id);
          env.PI_SESSION_ID_ENCODING = "json";
        }
        return context;
      },
    },
  }).filter((tool) => tool.name !== "read");
  return [...createReadOnlyTools(cwd), ...mutating];
}

/** Every tool an `AgentSession` registers on its own, whether or not a directory agent mounts it. */
function piRegisteredToolNames(cwd: string): string[] {
  return [
    ...createReadOnlyTools(cwd).map((tool) => tool.name),
    ...createCodingTools(cwd).map((tool) => tool.name),
    createPowerShellTool(cwd).name,
  ];
}

/** Built-ins omitted by an explicit lower-level tool list. */
function omittedBuiltinNames(mounted: readonly MountedTool[], cwd: string): string[] {
  const mountedNames = new Set(mounted.map((tool) => tool.name));
  return [...new Set(piRegisteredToolNames(cwd))].filter((name) => !mountedNames.has(name));
}

/**
 * The full directory-agent tool set: all pi coding tools + `config.tools` + discovered `tools/` (deduped, existing
 * win), plus the authored names and collisions to report.
 */
export async function resolveAgentTools(
  config: FastagentConfig,
  agentDir: string,
  cwd: string,
): Promise<{
  tools: MountedTool[];
  toolNames: string[];
  /**
   * Tools registered but not initially active (defineTool `deferred: true`) — discovered/activated via the built-in
   * `search_tools` loader.
   */
  deferredToolNames: string[];
  toolCollisions: ToolCollision[];
  toolFailures: ModuleLoadFailure[];
  /** Env vars the MOUNTED tools declared they need, BY TOOL NAME — a discovered tool shadowed by a
   *  coding tool or `config.tools` never executes, so its declaration is dropped here rather than
   *  gating a start. Per tool because a caller that runs exactly ONE of them (`fastagent tool`) must
   *  not be stopped by a sibling's credential; the serving paths flatten it (they mount all of
   *  them). DATA: `info` reports it and the deploy pre-flight carries it, while the serving opener
   *  asserts it (open.ts) — this function must stay reportable. */
  toolSecrets: Map<string, DeclaredSecret[]>;
}> {
  // Discovered `tools/` come from `agentDir` (the agent's own surface); the coding tools are rooted at `cwd`, the
  // WORKSPACE.
  const discovered = await loadTools(agentDir);
  const configured = piAllCodingTools(cwd);
  const configuredNames = new Set(configured.map((tool) => tool.name));
  const configuredCollisions: ToolCollision[] = [];
  // The config.tools that actually MOUNT — collected here rather than re-derived from `config.tools`
  // afterwards, so a tool dropped for sharing a coding tool's name cannot contribute a declaration
  // (its body never runs, and gating a start on its secret would refuse to serve for nothing).
  const mountedConfigTools: FastagentTool[] = [];
  for (const tool of config.tools ?? []) {
    if (configuredNames.has(tool.name)) {
      configuredCollisions.push({ name: tool.name, source: "config.tools" });
      continue;
    }
    configuredNames.add(tool.name);
    configured.push(tool);
    mountedConfigTools.push(tool);
  }
  const merged = mergeDiscoveredTools(configured, discovered.tools);
  // The built-in `search_tools` loader mounts here.
  const tools = withSearchTool(merged.tools);
  // Builtin = a search_tools that was ABSENT before withSearchTool (a reference compare would misfire on the
  // deferred-authored-loader case, where withSearchTool returns a new array without adding one).
  const builtinLoaderMounted =
    !merged.tools.some((t) => t.name === "search_tools") && tools.some((t) => t.name === "search_tools");
  const toolCollisions = [...discovered.collisions, ...configuredCollisions, ...merged.collisions];
  // `toolNames` is the AUTHOR's active-by-default surface (config.tools + tools/).
  // The discovered tools that were DROPPED (a coding tool or config.tools already owns the name):
  // asking the mounted set instead would read the winner's name as proof the loser is mounted.
  const shadowed = new Set(merged.collisions.map((c) => c.name));
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
    // Mounted only, and config.tools are FastagentTools too, so a programmatic tool declares the
    // same way a file does.
    toolSecrets: new Map([
      ...[...discovered.secrets].filter(([name]) => !shadowed.has(name)),
      // A programmatic tool declares the same way a file does. The source names the ENTRY, not just
      // the list: `source` has to point at something the author can find, and "config.tools" alone
      // locates nothing when the list has several tools. The shape was already refused by config
      // validation (config.ts), so a throw here means a FastagentConfig assembled in code bypassed
      // it — still the caller's own object, so it fails loudly rather than being isolated.
      ...mountedConfigTools.map((tool) => {
        const declaration = readSecretDeclaration(tool, `config.tools "${tool.name}"`);
        if (declaration.error !== undefined) throw new Error(declaration.error);
        return [tool.name, declaration.secrets] as [string, DeclaredSecret[]];
      }),
    ]),
  };
}

// Fastagent owns identity and project context; Pi appends skills and cwd for both serving and chat.

/** The pi engine's base prompt (segment ①), mirroring pi-coding-agent's default path with two deviations. */
export function piBasePrompt(options: { tools?: MountedTool[]; persona?: string } = {}): string {
  const mounted = options.tools ?? [];
  // Deferred tools stay OUT of the list: their schemas are not in the request until activated, so naming them here
  // would invite calls to tools that don't exist yet.
  const tools = mounted.filter((t) => !isDeferredTool(t));
  const deferredCount = mounted.length - tools.length;
  const toolsList =
    tools.length > 0 ? tools.map((t) => `- ${t.name}: ${(t.description ?? "").split("\n")[0]}`).join("\n") : "(none)";
  // Segment ① identity: an authored persona (persona.md) replaces the default engine identity line (core.md §2),
  // keeping the tools list + guidelines below.
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
  // How long the storage lives is the HOST's answer, not a deployment-wide one: AgentCore's managed
  // mount is reset by every deploy, so telling that agent to keep work "outside the definition" would
  // name a location its next deploy erases.
  const deploymentNote = !isDeployedWorkspace()
    ? ""
    : isAgentcoreRuntime()
      ? `\n\nYour workspace survives restarts, including uncommitted work; /tmp does not. Every deployment of a new version resets this host's storage entirely, so anything that must outlive a deployment belongs in an external system (a git remote, an issue tracker, a database). Markdown definition files are read each turn; changes to tools, channels or configuration take effect when the service restarts.`
      : `\n\nYour workspace survives restarts and deployments, including uncommitted work; /tmp does not. A new deployment replaces your definition directory with the author's release, so keep ongoing project work outside it. Markdown definition files are read each turn; changes to tools, channels or configuration take effect when the service restarts.`;
  return `${identity}

Available tools:
${toolsList}${deferredNote}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files${deploymentNote}`;
}

export interface AssembleSystemPromptOptions {
  /**
   * Base prompt (①), REQUIRED — no default: a defaulted piBasePrompt() would render "Available tools: (none)" even
   * when tools are mounted.
   */
  base: string;
  /**
   * ② project-context files (AGENTS.md et al. from loadProjectContextFiles); each wrapped `<project_instructions
   * path=…>`.
   */
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

/** The assembly, as a value: what every rung builds and what the agent runs on. */
export interface PiAssembly {
  lease: Lease;
  sessionFactory: PiAgentSessionFactory;
  /** The registry and configured model, resolved on first use (a credential read is async). */
  engine: () => Promise<{ modelRuntime: ModelRuntime; model: AnyModel }>;
  /** The configured reasoning effort — the other half of the pair a session without overrides runs on. */
  thinkingLevel: ThinkingLevel;
}

/** Shared low-level wiring: resolve the model spec against the collection, default the K ports, build the parts. */
function assemblePi(opts: {
  model: string;
  thinkingLevel?: ThinkingLevel;
  providers?: Provider[];
  authPath?: string;
  /** Read a provider `authPath` lacks from here instead; unset when an explicit path was named. */
  fallbackAuthPath?: string;
  /** The model registry to run on, used verbatim. */
  models?: ModelRuntime;
  readDefinition: PiAgentSessionFactoryOptions["readDefinition"];
  tools?: MountedTool[];
  /** Where conversations live. */
  sessions?: PiSessionRecordStore;
  /** Where pi reads its own settings; see {@link PiAgentSessionFactoryOptions.agentDir}. */
  agentDir?: string;
  /** The definition's extension entry points; see {@link PiAgentSessionFactoryOptions.extensionPaths}. */
  extensionPaths?: string[];
  env?: ExecutionEnv;
  /**
   * The WORKSPACE: where tools operate, what the model is told its working directory is, and what session records are
   * keyed to.
   */
  cwd?: string;
  lease?: Lease;
}): PiAssembly {
  const cwd = opts.cwd ?? opts.env?.cwd ?? process.cwd();
  // Materialized here (not defaulted inside the L0) so the value carries the SAME lease instance the agent runs under
  // — boundary mutations must contend on it.
  const lease = opts.lease ?? inProcessLease();
  const sessions = opts.sessions ?? piInMemorySessionRecordStore({ cwd });
  // The model and its runtime resolve on FIRST USE.
  let engine: Promise<{ modelRuntime: ModelRuntime; model: AnyModel }> | undefined;
  const resolveEngine = () => {
    engine ??= (async () => {
      // The caller's registry when there is one — the directory rung builds it from the agent's own models.json, so a
      // custom endpoint declared there is the one a turn resolves against.
      const modelRuntime =
        opts.models ??
        (await createPiModelRuntime({
          authPath: opts.authPath,
          ...(opts.fallbackAuthPath !== undefined ? { fallbackAuthPath: opts.fallbackAuthPath } : {}),
        }));
      // ModelRuntime registers providers by config record, so an injected Provider INSTANCE (a gateway, a self-hosted
      // endpoint, a test fake) goes in through its native seam.
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
    readDefinition: opts.readDefinition,
    cwd,
    ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
    ...(opts.extensionPaths ? { extensionPaths: opts.extensionPaths } : {}),
    // `noTools: "builtin"` leaves pi's built-ins in the registry; a lower-level replacement must also deny every
    // omitted coding name so a loader cannot reactivate one later.
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

/** L1 options. */
export interface CreatePiAgentOptions {
  /** Model spec "provider/modelId" (e.g. "openai-codex/gpt-5.5"), resolved against {@link models}. */
  model: string;
  /** Reasoning effort (pi's scale). */
  thinkingLevel?: ThinkingLevel;
  /**
   * The system prompt itself — no engine base and no wrapping (unlike the directory path, which assembles the engine
   * base + AGENTS.md as segment ② + persona.md as segment ①).
   */
  instructions?: string | (() => string);
  /** The tool set to mount: authored tools or pi's cwd-bound coding tools, both AgentTool. */
  tools?: MountedTool[];
  skills?: Skill[];
  // ── Tier 2: injectable ports ───────────────────────────────────────────────
  /**
   * Extra providers registered on top of the built-ins — your own gateway / self-hosted endpoint / test fake —
   * selected by the `model` spec's provider id.
   */
  providers?: Provider[];
  /** Credentials file for stored OAuth/API-key auth. */
  authPath?: string;
  /** Read a provider `authPath` lacks from here instead; unset when an explicit path was named. */
  fallbackAuthPath?: string;

  sessions?: PiSessionRecordStore;
  /** Supplies the working directory at L1 (default: process.cwd()), which loads no definition. */
  env?: ExecutionEnv;
  /** Single-writer lease. */
  lease?: Lease;
  /** Observation-plane tap (session control): every rich session event of every run. */
  observer?: SessionObserver;
}

/** L1: assemble from typed parts. */
export function createPiAgent(options: CreatePiAgentOptions): Agent {
  const { instructions, skills = [] } = options;
  return agentOf(
    assemblePi({
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      providers: options.providers,
      authPath: options.authPath,
      ...(options.fallbackAuthPath !== undefined ? { fallbackAuthPath: options.fallbackAuthPath } : {}),
      readDefinition: () => ({
        systemPrompt: typeof instructions === "function" ? instructions() : instructions,
        skills,
      }),
      // Deferred tools need their loader on every rung (idempotent; the caller's own search_tools wins).
      tools: options.tools ? withSearchTool(options.tools) : options.tools,
      sessions: options.sessions,
      env: options.env,
      lease: options.lease,
    }),
    options.observer,
  );
}

/** L2 options. */
export interface CreatePiAgentFromDefinitionOptions {
  /** Model spec "provider/modelId", resolved against {@link models}. */
  model: string;
  /** Reasoning effort (pi's scale). */
  thinkingLevel?: ThinkingLevel;
  /** Override the engine base prompt (segment ①). */
  base?: string;
  tools?: MountedTool[];
  /**
   * The agent's working directory: where the coding tools operate AND whose ancestors are walked for ② project context
   * (AGENTS.md).
   */
  cwd?: string;
  /** Extra providers registered on top of the built-ins (your own gateway / self-hosted endpoint). */
  providers?: Provider[];
  /** Credentials file (see {@link CreatePiAgentOptions.authPath}). */
  authPath?: string;
  /** Read a provider `authPath` lacks from here instead; unset when an explicit path was named. */
  fallbackAuthPath?: string;

  sessions?: PiSessionRecordStore;
  /** Filesystem/process environment; see {@link CreatePiAgentOptions.env}. */
  env?: ExecutionEnv;
  lease?: Lease;
  /** Observation-plane tap; see {@link CreatePiAgentOptions.observer}. */
  observer?: SessionObserver;
}

/** L2, as the value: load the directory (base + AGENTS.md + skills + env) and assemble. */
export async function assemblePiFromDefinition(
  dir: string,
  options: Omit<CreatePiAgentFromDefinitionOptions, "observer">,
): Promise<{ assembly: PiAssembly; definition: LoadedDefinition }> {
  // `dir` = the agent-definition dir (persona.md/skills/); `cwd` (default = dir) is the run root where tools operate
  // and whose ancestors are walked for ② context.
  const cwd = options.cwd ?? dir;
  const env = options.env ?? new NodeExecutionEnv({ cwd });
  // Boot-time load: fail-visibly at startup on a broken directory, and give callers the snapshot to report
  // (skills/diagnostics/collisions).
  const definition = await loadAgentDefinition(dir, { cwd, env });
  // Deferred tools need their loader on every rung (idempotent — the workspace opener already applied it; a caller's
  // own search_tools wins).
  const tools = withSearchTool(options.tools ?? piAllCodingTools(cwd));
  // Boot findings go through the SAME memoized reporter every later reader uses (report.ts, keyed by the resolved
  // dir).
  reportFindingsIfChanged(definition.dir, definition);
  // Dir-aware default: the same secrets-dir-derived file the opener uses for this dir (the opener passes an explicit
  // authPath, so this only affects direct L2 callers).
  // A path the CALLER named is an instruction; the default location is a preference, so only that one layers over
  // the user-global store (resolveAuthFallback says the same thing for the CLI).
  const authPath = options.authPath ?? defaultAuthPath(resolveSecretsDir(dir));
  const fallbackAuthPath = options.fallbackAuthPath ?? (options.authPath === undefined ? GLOBAL_AUTH_PATH : undefined);
  const assembly = assemblePi({
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    // THE directory rung's model surface: built-ins + the agent's own models.json (custom endpoints, which are
    // definition data and travel with the artifact) + any injected Provider instance.
    models: await createPiModelRuntime({
      agentDir: dir,
      authPath,
      ...(fallbackAuthPath !== undefined ? { fallbackAuthPath } : {}),
      providers: options.providers,
    }),
    authPath,
    // The directory is the agent, LIVE: re-read the definition on every invoke, so AGENTS.md/skills edits (the
    // author's, or the agent's own self-modification) take effect on the next turn with no process restart — restarts
    // are reserved for code (tools/channels/config, module cache).
    readDefinition: async () => {
      const def = await loadAgentDefinition(dir, { cwd, env });
      reportFindingsIfChanged(def.dir, def);
      return {
        systemPrompt: assembleSystemPrompt({
          // Segment ①: an authored persona (persona.md, def.persona) overrides the engine identity, re-read per turn
          // like AGENTS.md so edits go live.
          base: options.base ?? piBasePrompt({ tools, persona: def.persona }),
          // ② project context: AGENTS.md files (agentDir + cwd-ancestor walk) via loadProjectContextFiles.
          contextFiles: def.contextFiles,
        }),
        skills: def.skills,
      };
    },
    tools,
    sessions: options.sessions,
    // Discovered so the serving assembly can WARN that it does not run them (and so the refusals apply to the
    // artifact either way) — `chat` is where they load.
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
