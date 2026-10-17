/**
 * Agent assembly (configuration-time): the definition's assets (tools, prompt) plus the reusable ladder that puts a
 * pi agent together.
 */
import { toUSVString } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  createCodingTools,
  createPowerShellTool,
  createReadOnlyTools,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import type { Agent, AgentCommand } from "../../protocol.ts";
import { type LoopPortHooks, loopPort } from "../../loop-port.ts";
import { servingAgent } from "../../serving-layer.ts";
import { piLoopHarness } from "./loop-harness.ts";
import { servedExtensionCommands } from "./session-binding.ts";
import { type FastagentConfig, resolveModel } from "./config.ts";
import { isAgentcoreRuntime, isDeployedWorkspace } from "../../paths.ts";
import { type LoadedDefinition, loadAgentDefinition } from "./definition.ts";
import { reportFindingsIfChanged } from "./report.ts";
import { log } from "../../log.ts";
import { BUILTIN_EXTENSIONS, DISCOVERY, readMachine, withMachine } from "./machine.ts";
import type { ModuleLoadFailure } from "../../loader.ts";
import {
  type FastagentTool,
  type MountedTool,
  type ToolCollision,
  isDefaultActiveTool,
  loadTools,
  mergeDiscoveredTools,
} from "./tool.ts";
import { type DeclaredSecret, readSecretDeclaration } from "../../declared-secrets.ts";
import type { PiBindingOptions } from "./session-binding.ts";
import { type AnyModel, DEFAULT_THINKING_LEVEL } from "./models.ts";
import { type AgentModels, agentModels } from "./agent-models.ts";
import { type PiSessionRecordStore, piInMemorySessionRecordStore } from "./session-store.ts";
import type { ResolvedContent } from "../../content/resolve.ts";
import { unmarkDevServe } from "../../serving-command.ts";

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
        // What the agent runs is not `dev`'s own serving, even when `dev` is what runs the agent.
        unmarkDevServe(env);
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
  /** Where each mounted authored tool comes from, by name: its file below `tools/`, or `config.tools`. */
  toolSources: Map<string, string>;
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
  const merged = mergeDiscoveredTools(configured, discovered.tools, discovered.sources);
  const tools = merged.tools;
  const toolCollisions = [...discovered.collisions, ...configuredCollisions, ...merged.collisions];
  // `toolNames` is the AUTHOR's active-by-default surface (config.tools + tools/).
  // The discovered tools that were DROPPED (a coding tool or config.tools already owns the name):
  // asking the mounted set instead would read the winner's name as proof the loser is mounted.
  const shadowed = new Set(merged.collisions.map((c) => c.name));
  const { builtinExtensions } = await readMachine(agentDir);
  const defaultNames = new Set<string>(CODING_TOOL_NAMES);
  const toolNames = tools.filter((t) => !defaultNames.has(t.name) && isDefaultActiveTool(t)).map((t) => t.name);
  const toolSources = new Map<string, string>([
    ...mountedConfigTools.map((tool) => [tool.name, "config.tools"] as [string, string]),
    ...[...discovered.sources].filter(([name]) => !shadowed.has(name)),
  ]);
  return {
    tools,
    toolNames,
    toolSources,
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
  /** The agent directory and its content, for the `content` section; absent on L1, which loads no directory. */
  workingSet?: { agentDir: string; content: readonly ResolvedContent[] };
}): Record<string, string> {
  const sections: Record<string, string> = {};
  if (options.workingSet) sections.content = contentSection(options.workingSet);
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
  const runtimeChanges = ` Markdown definition files are read each turn, and schedules/ (a <name>.md whose frontmatter holds only cron and, optionally, tz, over the prompt; at most every 10 minutes, at most 20) within half a minute, and models.json from the next turn; changes to tools, channels or other configuration (fastagent.config.ts, context.json, .pi/settings.json, package.json) take effect when the service restarts. A tool you install yourself (apt-get, npm install -g) belongs to this machine and is gone when its container is replaced. To give yourself a new capability now, write a skill — a SKILL.md in your definition's skills/ directory, with any script it needs run through bash — or, for a tool or command of your own, a pi extension in extensions/, loaded from your next session on. Either lasts until the next deployment replaces that directory, so a capability that should outlast it belongs in the author's release: propose it to them.${
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

/** What a content entry of this kind is, said to the agent: where it is, and whether another instance shares it. */
function contentKind(c: ResolvedContent): string {
  if (c.kind !== "github") return "a directory on this machine";
  if (!c.clone) return `a checkout of github ${c.repo} on this machine`;
  // Brought up to date in place at each start where git can do so without touching the agent's work; what the agent
  // changes stays, and reaches anyone else only when pushed. The declared ref is what it follows, not a claim about
  // where it is: a clone the agent moved elsewhere is left there.
  const clone = `a shallow clone of github ${c.repo}${c.ref ? ` (declared ${c.ref})` : ""} in your own storage`;
  return c.readonly
    ? `${clone}, brought up to date each time you start`
    : `${clone}: what you change in it stays, and each time you start it is brought up to date where that touches nothing of yours; push to share a change`;
}

/**
 * Where the agent is and what it works on (agent-model.md §4): its own directory is itself, and each content entry is named
 * with its location, whether it is the agent's to change, and where a change there goes. A result written where it
 * does not last is how knowledge gets lost, so the agent is told which is which.
 */
function contentSection({ agentDir, content }: { agentDir: string; content: readonly ResolvedContent[] }): string {
  const own =
    `Your working directory, ${agentDir}, is your own directory: it holds your definition, and files you create ` +
    `land there unless you put them elsewhere.`;
  if (content.length === 0) return `${own} Nothing else is declared for you: you work only in your own directory.`;
  const line = (c: ResolvedContent) =>
    `- ${c.name}: ${c.location} (${contentKind(c)})${c.description !== undefined ? ` ${c.description}` : ""}`;
  const worksOn = content.filter((c) => !c.readonly);
  const knows = content.filter((c) => c.readonly);
  return [
    own,
    ...(worksOn.length > 0 ? ["You work on:", ...worksOn.map(line)] : []),
    ...(knows.length > 0 ? ["You know, and do not write:", ...knows.map(line)] : []),
    `Run a command in one of these directories with \`cd <its location> && …\`; file tools take the location directly.` +
      (worksOn.length > 0
        ? " A result worth keeping belongs in a directory you work on, not in your own directory."
        : " You write only in your own directory: the directories above are for reading."),
  ].join("\n");
}

// ── §3 the reusable assembly ladder: L1 / L2 ────────────────────────────────

/** The assembly, as a value: what every rung builds and what the agent runs on. */
export interface PiAssembly {
  /** What binds a session to a record: everything but the store, which is `sessions`. */
  binding: PiBindingOptions;
  sessions: PiSessionRecordStore;
  /** Extension-aware catalog for startup reporting and control-plane validation; never bound to a session. */
  modelRuntime: () => Promise<ModelRuntime>;
  /** A fresh runtime for every session, before loading its extensions. */
  createModelRuntime: () => Promise<ModelRuntime>;
  /**
   * The default model, resolved against the catalog on first use (a credential read is async); throws when it does not
   * resolve. Undefined when the assembly has no default: each session then runs on the model it records
   * (session-binding.ts).
   */
  resolveDefaultModel: () => Promise<AnyModel | undefined>;
  /** The configured reasoning effort — the other half of the pair a session without overrides runs on. */
  thinkingLevel: ThinkingLevel;
  /** The tools every session mounts. */
  tools: MountedTool[];
  /** Pi built-ins the mounted tools leave out, denied in every session so discovery cannot bring them back. */
  excludedToolNames: readonly string[];
  /** The prompt and skills a session runs on, read when a session is bound. */
  readDefinition: PiBindingOptions["readDefinition"];
  /** The extension entry points a session loads, listed afresh for each (the catalog's own discovery). */
  extensionPaths: () => Promise<readonly string[]>;
  /** The agent's content, resolved: what its tools see as `ctx.content`. */
  content: readonly ResolvedContent[];
}

/** Shared low-level wiring: resolve the model spec against the collection, default the K ports, build the parts. */
function assemblePi(opts: {
  /** The default model spec; see {@link PiBindingOptions.modelSpec}. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** The model registry to run on, resolved on first use. */
  models: () => Promise<ModelRuntime>;
  catalog: () => Promise<ModelRuntime>;
  readDefinition: PiBindingOptions["readDefinition"];
  tools?: MountedTool[];
  /** Where conversations live. */
  sessions?: PiSessionRecordStore;
  /** The definition's extension entry points; see {@link PiBindingOptions.extensionPaths}. */
  extensionPaths?: () => Promise<readonly string[]>;
  /**
   * The working directory: where tools operate, what the model is told its working directory is, and what session
   * records are keyed to. The agent directory on the directory path.
   */
  cwd?: string;
  /** What authored tools see as `ctx.content`. */
  content?: readonly ResolvedContent[];
}): PiAssembly {
  const cwd = opts.cwd ?? process.cwd();
  const sessions = opts.sessions ?? piInMemorySessionRecordStore({ cwd });
  const createModelRuntime = opts.models;
  // Not memoized here: the catalog is shared until the extensions' code changes, and rebuilt then (agent-models.ts).
  const modelRuntime = opts.catalog;
  const resolveDefaultModel = async (): Promise<AnyModel | undefined> => {
    const runtime = await modelRuntime();
    return opts.model ? resolveModel(runtime, opts.model) : undefined;
  };
  // Deny omitted coding names so discovery cannot reintroduce tools a lower-level caller excluded.
  const excludedToolNames = omittedBuiltinNames(opts.tools ?? [], cwd);
  const binding: PiBindingOptions = {
    createModelRuntime,
    ...(opts.model ? { modelSpec: opts.model } : {}),
    ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    readDefinition: opts.readDefinition,
    cwd,
    content: opts.content ?? [],
    ...(opts.extensionPaths ? { extensionPaths: opts.extensionPaths } : {}),
    excludedToolNames,
  };
  return {
    binding,
    sessions,
    modelRuntime,
    createModelRuntime,
    resolveDefaultModel,
    thinkingLevel: opts.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    tools: opts.tools ?? [],
    excludedToolNames,
    readDefinition: opts.readDefinition,
    extensionPaths: opts.extensionPaths ?? (async () => []),
    content: opts.content ?? [],
  };
}

/**
 * The agent an assembly runs as: SPEC v1 over one LoopPort, which holds each session's one writer while it is busy.
 * `commands` is what a client may offer; `hooks` lets a serve count the work in flight.
 */
export function agentOf(
  assembly: PiAssembly,
  options: { commands?: () => Promise<AgentCommand[]>; hooks?: LoopPortHooks } = {},
): Agent {
  return servingAgent(
    loopPort(
      piLoopHarness({
        ...assembly.binding,
        sessions: assembly.sessions,
        catalog: assembly.modelRuntime,
        ...(options.commands ? { commands: options.commands } : {}),
      }),
      undefined,
      options.hooks,
    ),
  );
}

/**
 * The names a `/` composer completes: this agent's skills and prompt templates — the definition's, plus the ones its
 * machine lends (machine.ts) — and the commands its `extensions/` register.
 *
 * `source` says how a name is INVOKED, which is the one thing a client needs from it: a `skill` is sent as
 * `/skill:<name>`, an `extension` command and a `prompt` as `/<name>` (docs/design/agent-service.md §7.4).
 *
 * The definition is read live, like every turn reads it; the machine is the process's one read, the same snapshot a
 * bound session runs on, so the menu cannot offer a name the next prompt would not expand. The same holds for
 * extensions: `served` is what sessions load — the entry points `extensions/` holds now, asked through the same
 * live-extensions check a session's load goes through (live-extensions.ts), and the runtime turns run on (asked only
 * when there are extensions) — never a listing of its own.
 */
export async function agentCommands(
  agentDir: string,
  served: { extensionPaths: () => Promise<readonly string[]>; modelRuntime: () => Promise<ModelRuntime> },
): Promise<AgentCommand[]> {
  // The whole definition, read the way a turn reads it: a skill whose frontmatter broke simply is not in `skills`, and
  // would vanish from the composer with no signal. The SAME findings a turn reports, so the per-directory memo sees
  // one set from both readers instead of warning again after every menu request.
  const own = await loadAgentDefinition(agentDir);
  reportFindingsIfChanged(own.dir, own);
  const machine = await readMachine(agentDir);
  const prompts = withMachine(own.prompts, machine.prompts);
  const extensionPaths = await served.extensionPaths();
  const extensionCommands = await servedExtensionCommands({
    cwd: agentDir,
    modelRuntime: await served.modelRuntime(),
    extensionPaths,
  });
  // pi dispatches an extension command before it expands a template, so a template it shadows never runs.
  const shadowed = new Set(extensionCommands.map((command) => command.invocationName));
  return [
    ...withMachine(own.skills, machine.skills).map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: "skill",
    })),
    ...extensionCommands.map((command) => ({
      name: command.invocationName,
      ...(command.description ? { description: command.description } : {}),
      source: "extension",
    })),
    ...prompts
      .filter((prompt) => !shadowed.has(prompt.name))
      .map((prompt) => ({
        name: prompt.name,
        ...(prompt.description ? { description: prompt.description } : {}),
        source: "prompt",
      })),
  ];
}

/** L1 options. */
export interface CreatePiAgentOptions {
  /** Model spec "provider/modelId" (e.g. "openai-codex/gpt-5.5"), resolved against {@link models}. */
  model: string;
  /** Reasoning effort (pi's scale). */
  thinkingLevel?: ThinkingLevel;
  /**
   * The system prompt itself — no harness base and no wrapping (unlike the directory path, where pi builds its
   * default prompt, or SYSTEM.md replaces it, and AGENTS.md, APPEND_SYSTEM.md and FastAgent's sections are added).
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
  /** Where tools operate and what session records are keyed to (default `process.cwd()`). */
  cwd?: string;
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
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    }),
  );
}

/** L2 options. */
export interface CreatePiAgentFromDefinitionOptions {
  /**
   * The default model spec "provider/modelId", resolved against {@link models}. Optional: without it, a session runs
   * on the model it records, and one that records none fails its invoke with `missing_model`.
   */
  model?: string;
  /** Reasoning effort (pi's scale). */
  thinkingLevel?: ThinkingLevel;
  /**
   * Replaces pi's default prompt, as `SYSTEM.md` does, and outranks it. Required when `tools` replaces the coding
   * tools and the directory has no `SYSTEM.md`: pi's default would claim tools the agent does not have.
   */
  base?: string;
  tools?: MountedTool[];
  /**
   * What the agent works on and knows, resolved (`resolveContent`): the prompt names each one, and tools see them as
   * `ctx.content`. None by default.
   */
  content?: readonly ResolvedContent[];
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
}

/**
 * L2, as the value: load the directory (base + AGENTS.md + skills) and assemble. `models` is the directory's
 * model environment when the caller already built it (the opener, whose report must describe what runs); otherwise it
 * is built here from the credential options.
 */
export async function assemblePiFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions & { models?: AgentModels },
): Promise<{ assembly: PiAssembly; definition: LoadedDefinition }> {
  // The agent directory is the working directory: where tools operate and what session records are keyed to.
  const cwd = dir;
  const content = options.content ?? [];
  // Boot-time load: fail-visibly at startup on a broken directory, and give callers the snapshot to report
  // (skills/diagnostics/collisions).
  const definition = await loadAgentDefinition(dir);
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
  const models =
    options.models ??
    agentModels(dir, options, {
      ...(providers ? { providers } : {}),
      ...(options.model ? { keepsModel: options.model } : {}),
    });
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
      const def = await loadAgentDefinition(dir);
      reportFindingsIfChanged(def.dir, def);
      const systemPrompt = options.base ?? def.systemPrompt?.content;
      refuseDefaultPromptOverReplacedTools(tools, systemPrompt !== undefined);
      return {
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(def.appendSystemPrompt ? { appendSystemPrompt: def.appendSystemPrompt.content } : {}),
        contextFiles: def.contextFiles,
        sections: fastagentPromptSections({ tools, builtinExtensions, workingSet: { agentDir: def.dir, content } }),
        skills: def.skills,
        prompts: def.prompts,
      };
    },
    tools,
    sessions: options.sessions,
    // The catalog's own discovery: the models it registered and the extensions sessions load are one listing.
    extensionPaths: models.extensionPaths,
    cwd,
    content,
  });
  return { assembly, definition };
}

/** L2: "point at a directory → agent": {@link assemblePiFromDefinition}, run as {@link agentOf}. */
export async function createPiAgentFromDefinition(
  dir: string,
  options: CreatePiAgentFromDefinitionOptions,
): Promise<{ agent: Agent; definition: LoadedDefinition }> {
  const { assembly, definition } = await assemblePiFromDefinition(dir, options);
  return { agent: agentOf(assembly, { commands: () => directoryCommands(dir, assembly) }), definition };
}

/** What a client offers is what a run WOULD run: built through the same resource posture a run uses. */
export function directoryCommands(dir: string, assembly: PiAssembly): Promise<AgentCommand[]> {
  return agentCommands(dir, { extensionPaths: assembly.extensionPaths, modelRuntime: assembly.createModelRuntime });
}
