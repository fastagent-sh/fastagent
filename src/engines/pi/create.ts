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
import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import type { Agent } from "../../agent.ts";
import { type FastagentConfig, resolveModel } from "./config.ts";
import { isAgentcoreRuntime, isDeployedWorkspace } from "../../paths.ts";
import { type LoadedDefinition, loadAgentDefinition } from "./definition.ts";
import { reportFindingsIfChanged } from "./report.ts";
import { log } from "../../log.ts";
import { BUILTIN_EXTENSIONS, DISCOVERY, readMachine } from "./machine.ts";
import type { ModuleLoadFailure } from "../../loader.ts";
import { type FastagentTool, type ToolCollision, loadTools, mergeDiscoveredTools, type MountedTool } from "./tool.ts";
import { type DeclaredSecret, readSecretDeclaration } from "../../declared-secrets.ts";
import { type PiAgentSessionFactory, createPiAgentFromSession } from "./invoke-session.ts";
import { type PiAgentSessionFactoryOptions, piAgentSessionFactory } from "./agent-session-factory.ts";
import { type AnyModel, DEFAULT_THINKING_LEVEL } from "./models.ts";
import { type AgentModels, agentModels } from "./agent-models.ts";
import { type PiSessionRecordStore, piInMemorySessionRecordStore } from "./session-store.ts";
import { type Lease, type SessionObserver, inProcessLease } from "./turn-kit.ts";

// ── §1 tools ─────────────────────────────────────────────────────────────────
//
// A directory agent gets every pi coding tool.

/**
 * Every pi coding tool, in canonical order, rooted at the agent directory. pi ships two overlapping groupings
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

function isDefaultActiveTool(tool: MountedTool): boolean {
  return (
    (!tool.exposure || tool.exposure === "direct" || tool.exposure === "model-only") && tool.defaultActive !== false
  );
}

/** How the model reaches a mounted tool it is not given up front. */
export type ToolReach = "tool_search" | "codemode" | "hidden" | "inactive" | "unreachable";

/** A mounted authored tool outside the default-active surface, and its way in. */
export interface IndirectTool {
  name: string;
  reach: ToolReach;
}

/** The built-in extension a `codemode`/`deferred` tool is reached through ({@link DISCOVERY}). */
function wayIn(tool: MountedTool): string | undefined {
  return tool.exposure === "codemode" || tool.exposure === "deferred" ? DISCOVERY[tool.exposure].extension : undefined;
}

/** Whether this machine leaves the tool's way in enabled (a tool that needs none always has one). */
function hasWayIn(tool: MountedTool, builtinExtensions: readonly string[]): boolean {
  const extension = wayIn(tool);
  return extension === undefined || builtinExtensions.includes(extension);
}

function indirectReach(tool: MountedTool, builtinExtensions: readonly string[]): ToolReach | undefined {
  if (isDefaultActiveTool(tool)) return undefined;
  if (!hasWayIn(tool, builtinExtensions)) return "unreachable";
  if (tool.exposure === "deferred") return "tool_search";
  if (tool.exposure === "codemode") return "codemode";
  if (tool.exposure === "hidden") return "hidden";
  // `defaultActive: false`: only an authored loader (`ToolContext.tools.activate`) brings it in.
  return "inactive";
}

/**
 * The full directory-agent tool set: all pi coding tools + `config.tools` + discovered `tools/` (deduped, existing
 * win), plus the authored names and collisions to report.
 */
export async function resolveAgentTools(
  config: FastagentConfig,
  agentDir: string,
): Promise<{
  tools: MountedTool[];
  toolNames: string[];
  /** Mounted authored tools the model is not given up front, with how each is reached. */
  indirectTools: IndirectTool[];
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
  // Discovered `tools/` and the coding tools' working directory are both the agent directory.
  const discovered = await loadTools(agentDir);
  const configured = piAllCodingTools(agentDir);
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
  const tools = merged.tools;
  const toolCollisions = [...discovered.collisions, ...configuredCollisions, ...merged.collisions];
  // `toolNames` is the AUTHOR's active-by-default surface (config.tools + tools/).
  // The discovered tools that were DROPPED (a coding tool or config.tools already owns the name):
  // asking the mounted set instead would read the winner's name as proof the loser is mounted.
  const shadowed = new Set(merged.collisions.map((c) => c.name));
  const { builtinExtensions } = await readMachine(agentDir);
  const defaultNames = new Set<string>(CODING_TOOL_NAMES);
  const toolNames = tools.filter((t) => !defaultNames.has(t.name) && isDefaultActiveTool(t)).map((t) => t.name);
  return {
    tools,
    toolNames,
    indirectTools: tools.flatMap((t) => {
      const reach = defaultNames.has(t.name) ? undefined : indirectReach(t, builtinExtensions);
      return reach ? [{ name: t.name, reach }] : [];
    }),
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

// pi builds the prompt (its default, or SYSTEM.md in its place); FastAgent adds its own named sections after it.

/** The tools pi's default prompt says the agent has ("reading files, executing commands, editing code"). */
const CODING_IDENTITY_TOOLS = ["read", "bash", "edit", "write"] as const;

/**
 * Refuse a prompt that would claim tools the agent does not have: pi's default says the agent reads files, runs
 * commands and edits code, which an embedder that replaced the coding tools made false. A prompt of the agent's own
 * (`base`, or `SYSTEM.md`) describes it instead. Checked at assembly and on every turn, since `SYSTEM.md` is re-read
 * per turn and an agent may delete it.
 */
function refuseDefaultPromptOverReplacedTools(tools: readonly MountedTool[], hasOwnPrompt: boolean): void {
  if (hasOwnPrompt) return;
  const mounted = new Set(tools.map((tool) => tool.name));
  const missing = CODING_IDENTITY_TOOLS.filter((name) => !mounted.has(name));
  if (missing.length === 0) return;
  throw new Error(
    `the coding tools were replaced (${missing.join(", ")} not mounted), so pi's default prompt, which says the agent ` +
      `reads files, runs commands and edits code, does not describe this agent: pass \`base\` or write SYSTEM.md`,
  );
}

/**
 * FastAgent's own prompt sections (docs/design/agent-model.md §2): what pi's prompt cannot know. Each is a named
 * section pi renders after its own, so it holds whoever wrote the rest of the prompt.
 */
export function fastagentPromptSections(options: {
  tools: readonly MountedTool[];
  /** The {@link BUILTIN_EXTENSIONS} this machine leaves enabled (`Machine.builtinExtensions`). */
  builtinExtensions: readonly string[];
}): Record<string, string> {
  const sections: Record<string, string> = {};
  const mountedNames = new Set(options.tools.map((tool) => tool.name));
  // Only `deferred` tools are tool_search's to load (the session activates it for them); `codemode` ones are listed
  // in codemode's own description, and an inactive direct tool is reached only through an authored activation.
  // A disabled tool-search leaves them no way in, and naming tool_search would invite calls to a tool that is not there.
  const deferredCount = options.tools.filter(
    (tool) => tool.exposure === "deferred" && hasWayIn(tool, options.builtinExtensions),
  ).length;
  if (deferredCount > 0) {
    sections.deferred_tools = `${deferredCount} additional tool(s) are registered but not loaded — use tool_search to find and load them before concluding a capability is missing.`;
  }
  // What takes effect when, and the agent's own path to a new capability, are the same on every host; only how long
  // the storage lives differs, below. The skill it writes lives in the definition directory, which the next
  // deployment replaces (or, on AgentCore, erases with everything else) — so the sentence says so, and where a skill
  // that should outlast it has to go. A skill outside the definition would survive, but it is machine state, read
  // once per process (machine.ts), so it would not be live.
  const runtimeChanges = ` Markdown definition files are read each turn; changes to tools, channels or configuration take effect when the service restarts. To give yourself a new capability now, write a skill — a SKILL.md in your definition's skills/ directory, with any script it needs run through bash. It lasts until the next deployment replaces that directory, so a capability that should outlast it belongs in the author's release: propose it to them.${
    // Named only when mounted (a serve; not a one-shot invoke), like the deferred tools above: naming a tool the model
    // does not have invites calls to it.
    mountedNames.has("wake") ? " To schedule your own follow-up work, use the wake tool." : ""
  }`;
  // How long the storage lives is the HOST's answer, not a deployment-wide one: AgentCore's managed mount is reset by
  // every deploy, so telling that agent to keep work "outside the definition" would name a location its next deploy
  // erases.
  if (isDeployedWorkspace()) {
    const deployment = isAgentcoreRuntime()
      ? "Every deployment of a new version resets this host's storage entirely"
      : "Each deployment replaces your directory with the author's release";
    sections.self_change = `Your directory survives restarts, including uncommitted work; /tmp does not. ${deployment}, so anything that must outlive a deployment belongs in an external system (a git remote, an issue tracker, a database).${runtimeChanges}`;
  }
  return sections;
}

// ── §3 the reusable assembly ladder: L1 / L2 ────────────────────────────────

/** The assembly, as a value: what every rung builds and what the agent runs on. */
export interface PiAssembly {
  lease: Lease;
  sessionFactory: PiAgentSessionFactory;
  /** Extension-aware catalog for startup reporting and control-plane validation; never bound to a session. */
  modelRuntime: () => Promise<ModelRuntime>;
  /** A fresh runtime for every session, before loading its extensions. */
  createModelRuntime: () => Promise<ModelRuntime>;
  /** The registry and configured model, resolved on first use (a credential read is async). */
  engine: () => Promise<{ modelRuntime: ModelRuntime; model: AnyModel }>;
  /** The configured reasoning effort — the other half of the pair a session without overrides runs on. */
  thinkingLevel: ThinkingLevel;
  /** The tools every session mounts. */
  tools: MountedTool[];
  /** Pi built-ins the mounted tools leave out, denied in every session so discovery cannot bring them back. */
  excludedToolNames: readonly string[];
  /** The prompt and skills a session runs on, read when a session is bound. */
  readDefinition: PiAgentSessionFactoryOptions["readDefinition"];
  /** The extension entry points every session loads, discovered once with the assembly. */
  extensionPaths: readonly string[];
}

/** Shared low-level wiring: resolve the model spec against the collection, default the K ports, build the parts. */
function assemblePi(opts: {
  model: string;
  thinkingLevel?: ThinkingLevel;
  /** The model registry to run on, resolved on first use. */
  models: () => Promise<ModelRuntime>;
  catalog: () => Promise<ModelRuntime>;
  readDefinition: PiAgentSessionFactoryOptions["readDefinition"];
  tools?: MountedTool[];
  /** Where conversations live. */
  sessions?: PiSessionRecordStore;
  /** The definition's extension entry points; see {@link PiAgentSessionFactoryOptions.extensionPaths}. */
  extensionPaths?: string[];
  env?: ExecutionEnv;
  /**
   * The working directory: where tools operate, what the model is told its working directory is, and what session
   * records are keyed to. The agent directory on the directory path.
   */
  cwd?: string;
  lease?: Lease;
}): PiAssembly {
  const cwd = opts.cwd ?? opts.env?.cwd ?? process.cwd();
  // Materialized here (not defaulted inside the L0) so the value carries the SAME lease instance the agent runs under
  // — boundary mutations must contend on it.
  const lease = opts.lease ?? inProcessLease();
  const sessions = opts.sessions ?? piInMemorySessionRecordStore({ cwd });
  const createModelRuntime = opts.models;
  let registry: Promise<ModelRuntime> | undefined;
  const modelRuntime = () => {
    registry ??= opts.catalog();
    return registry;
  };
  let engine: Promise<{ modelRuntime: ModelRuntime; model: AnyModel }> | undefined;
  const resolveEngine = () => {
    engine ??= modelRuntime().then((runtime) => ({ modelRuntime: runtime, model: resolveModel(runtime, opts.model) }));
    return engine;
  };
  // Deny omitted coding names so discovery cannot reintroduce tools a lower-level caller excluded.
  const excludedToolNames = omittedBuiltinNames(opts.tools ?? [], cwd);
  const sessionFactory = piAgentSessionFactory({
    sessions,
    engine: async () => ({ modelRuntime: await createModelRuntime() }),
    modelSpec: opts.model,
    thinkingLevel: opts.thinkingLevel,
    tools: opts.tools,
    readDefinition: opts.readDefinition,
    cwd,
    ...(opts.extensionPaths ? { extensionPaths: opts.extensionPaths } : {}),
    excludedToolNames,
  });
  return {
    lease,
    sessionFactory,
    modelRuntime,
    createModelRuntime,
    engine: resolveEngine,
    thinkingLevel: opts.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    tools: opts.tools ?? [],
    excludedToolNames,
    readDefinition: opts.readDefinition,
    extensionPaths: opts.extensionPaths ?? [],
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
   * The system prompt itself — no engine base and no wrapping (unlike the directory path, where pi builds its default
   * prompt, or SYSTEM.md replaces it, and AGENTS.md, APPEND_SYSTEM.md and FastAgent's sections are added).
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
  /** Credentials file for stored OAuth/API-key auth (default `GLOBAL_AUTH_PATH`). */
  authPath?: string;
  /** The caller's own credential store, in place of any file ({@link CredentialSourceOptions}). */
  credentialStore?: CredentialStore;

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
  const models = agentModels(undefined, options, { providers: options.providers });
  return agentOf(
    assemblePi({
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      models: models.createRuntime,
      catalog: models.runtime,
      // No instructions is an empty prompt, not pi's default: this path takes the prompt whole.
      readDefinition: () => ({
        systemPrompt: (typeof instructions === "function" ? instructions() : instructions) || " ",
        skills,
      }),
      tools: options.tools,
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
  /**
   * Replaces pi's default prompt, as `SYSTEM.md` does, and outranks it. Required when `tools` replaces the coding
   * tools and the directory has no `SYSTEM.md`: pi's default would claim tools the agent does not have.
   */
  base?: string;
  tools?: MountedTool[];
  /** Extra providers registered on top of the built-ins (your own gateway / self-hosted endpoint). */
  providers?: Provider[];
  /**
   * Credentials file. Unset reads the directory's own layers (`resolveAuthLayers`); a named file is an instruction and
   * gets no second layer.
   */
  authPath?: string;
  /** The caller's own credential store, in place of any file ({@link CredentialSourceOptions}). */
  credentialStore?: CredentialStore;

  sessions?: PiSessionRecordStore;
  /** Filesystem/process environment; see {@link CreatePiAgentOptions.env}. */
  env?: ExecutionEnv;
  lease?: Lease;
  /** Observation-plane tap; see {@link CreatePiAgentOptions.observer}. */
  observer?: SessionObserver;
}

/**
 * L2, as the value: load the directory (base + AGENTS.md + skills + env) and assemble. `models` is the directory's
 * model environment when the caller already built it (the opener, whose report must describe what runs); otherwise it
 * is built here from the credential options.
 */
export async function assemblePiFromDefinition(
  dir: string,
  options: Omit<CreatePiAgentFromDefinitionOptions, "observer"> & { models?: AgentModels },
): Promise<{ assembly: PiAssembly; definition: LoadedDefinition }> {
  // The agent directory is the working directory: where tools operate and what session records are keyed to.
  const cwd = dir;
  const env = options.env ?? new NodeExecutionEnv({ cwd });
  // Boot-time load: fail-visibly at startup on a broken directory, and give callers the snapshot to report
  // (skills/diagnostics/collisions).
  const definition = await loadAgentDefinition(dir, { env });
  const tools = options.tools ?? piAllCodingTools(cwd);
  // Boot findings go through the SAME memoized reporter every later reader uses (report.ts, keyed by the resolved
  // dir).
  reportFindingsIfChanged(definition.dir, definition);
  // pi treats an empty prompt as none and builds its default, so a blank `base` would look like a prompt of the
  // caller's own while being nothing.
  if (options.base !== undefined && options.base.trim() === "") {
    throw new Error("`base` is empty: pass the prompt the agent should use, or leave `base` out for pi's default");
  }
  refuseDefaultPromptOverReplacedTools(tools, options.base !== undefined || definition.systemPrompt !== undefined);
  const { providers } = options;
  const models = options.models ?? agentModels(dir, options, { env, ...(providers ? { providers } : {}) });
  // Built at boot, so a malformed models.json fails the assembly rather than its first turn. The directory's own
  // models.json is what a turn resolves against, layered over the machine's (models.ts).
  await models.runtime();
  const { builtinExtensions } = await readMachine(dir);
  const unreachable = tools.filter((tool) => !hasWayIn(tool, builtinExtensions));
  // Said once per assembly: the model cannot call these at all, while the tools themselves loaded fine.
  for (const tool of unreachable) {
    log.warn(
      `[fastagent] tool "${tool.name}" (exposure: ${tool.exposure}) cannot be reached: pi's settings disable ` +
        `builtin:${wayIn(tool)}, its only way in`,
    );
  }
  const assembly = assemblePi({
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    models: models.createRuntime,
    catalog: models.runtime,
    // The directory is the agent, LIVE: re-read the definition on every invoke, so AGENTS.md/skills edits (the
    // author's, or the agent's own self-modification) take effect on the next turn with no process restart — restarts
    // are reserved for code (tools/channels/config, module cache).
    readDefinition: async () => {
      const def = await loadAgentDefinition(dir, { env });
      reportFindingsIfChanged(def.dir, def);
      const systemPrompt = options.base ?? def.systemPrompt?.content;
      refuseDefaultPromptOverReplacedTools(tools, systemPrompt !== undefined);
      return {
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(def.appendSystemPrompt ? { appendSystemPrompt: def.appendSystemPrompt.content } : {}),
        sections: fastagentPromptSections({ tools, builtinExtensions }),
        skills: def.skills,
        prompts: def.prompts,
      };
    },
    tools,
    sessions: options.sessions,
    // The catalog's own discovery: the models it registered and the extensions sessions load are one list.
    extensionPaths: [...(await models.extensionPaths())],
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
