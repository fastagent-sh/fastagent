/**
 * Open a definition directory into an agent — the single agent opener BOTH `fastagent dev` and `fastagent start`
 * drive.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "../../agent.ts";
import { type FastagentConfig, type LoadedConfig, loadConfig, resolveModel, resolveModelSpec } from "./config.ts";
import type { Models } from "@earendil-works/pi-ai";
import {
  AGENT_MODEL_CATALOG_FILE,
  resolveAgentDir,
  resolveOverridePath,
  resolveSessionsDir,
  resolveStateRoot,
} from "../../paths.ts";
import type { AgentCommand, ModelDescriptor, SessionControl } from "../../session.ts";
import { describeModels } from "./session-settings.ts";
import { type IndirectTool, type PiAssembly, agentOf, assemblePiFromDefinition, resolveAgentTools } from "./create.ts";
import type { SessionObserver } from "./turn-kit.ts";
import { createPiSessionControl } from "./session-control.ts";
import { withWakeTool } from "./wake-tool.ts";
import { refuseBrokenDeclarations } from "../../loader.ts";
import { type LoadedDefinition, loadAgentDefinition } from "./definition.ts";
import { servedExtensionCommands } from "./agent-session-factory.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { reportFindingsIfChanged } from "./report.ts";
import { readMachine, withMachine } from "./machine.ts";
import type { CredentialSourceOptions, FastagentAuthOptions } from "./auth.ts";
import { createPiModelRuntime, globalCatalogPath, machineModelRuntime, refreshCatalog } from "./models.ts";
import { type AgentModels, agentModels } from "./agent-models.ts";
import { OPENAI_PROVIDER, missingAccountModels } from "./openai-account-models.ts";
import { log } from "../../log.ts";
import { type PiSessionRecordStore, piSessionRecordStore } from "./session-store.ts";
import type { ToolCollision, MountedTool } from "./tool.ts";
import type { DeclaredSecret } from "../../declared-secrets.ts";
import { gateSecrets } from "../../secrets-gate.ts";
import type { HttpSurface } from "../../service.ts";
import { type ResolvedContext, cloneContext, contextsAbsentHere, resolveContexts } from "../../contexts/resolve.ts";

/**
 * The names a `/` composer completes: this agent's skills and prompt templates — the definition's, plus the ones its
 * machine lends (machine.ts) — and the commands its `extensions/` register.
 *
 * `source` says how a name is INVOKED, which is the one thing a client needs from it: a `skill` is sent as
 * `/skill:<name>`, an `extension` command and a `prompt` as `/<name>` (docs/design/session-control.md §5.1.1).
 *
 * The definition is read live, like every turn reads it; the machine is the process's one read, the same snapshot a
 * bound session runs on, so the menu cannot offer a name the next prompt would not expand. The same holds for
 * extensions: `served` is what sessions load — the entry points `extensions/` holds now, asked through the same
 * live-extensions check a session's load goes through (live-extensions.ts), and the runtime turns run on (asked only
 * when there are extensions) — never a listing of its own.
 */
export async function agentCommands(
  agentDir: string,
  contexts: readonly ResolvedContext[],
  served: { extensionPaths: () => Promise<readonly string[]>; modelRuntime: () => Promise<ModelRuntime> },
): Promise<AgentCommand[]> {
  // The whole definition, read the way a turn reads it: a skill whose frontmatter broke simply is not in `skills`, and
  // would vanish from the composer with no signal. The SAME findings a turn reports, so the per-directory memo sees
  // one set from both readers instead of warning again after every menu request.
  const own = await loadAgentDefinition(agentDir, { contexts });
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

export interface CreatePiAgentFromDirOptions {
  /** Model spec override (e.g. the CLI --model flag). */
  model?: string;
  /**
   * Where conversations are stored, for an EMBEDDER that puts them somewhere the state root does not cover. There is
   * no env or flag spelling of it: sessions are machine state, and the one knob that moves machine state is
   * `FASTAGENT_STATE_DIR` (see {@link resolveSessionsDir}). Read like every path override, `authPath` included
   * ({@link resolveOverridePath}): a leading `~` is the home directory, and a relative path is the process's.
   */
  sessionsDir?: string;
  /** Credentials file override. */
  authPath?: string;
  /** The caller's own credential store, in place of any file ({@link CredentialSourceOptions}). */
  credentialStore?: CredentialStore;
  /**
   * This is a long-running SERVE (`dev`/`start`), where the scheduler poller runs — so a self-scheduled wake-up is
   * actually honored.
   */
  serving?: boolean;
  /**
   * Wire the control plane's BOUNDARY (model changes, fork, delete) and publish it. A serve always gets the hub
   * itself — stopping the running turn is a chat command, not a management endpoint — so this is the answer to
   * "may a remote caller steer and rewrite this deployment", nothing else. Defaults to `config.sessionControl`.
   */
  sessionControl?: boolean;
  /** Additional raw tap with the FULL vocabulary. */
  observer?: SessionObserver;
}

/**
 * The agent assembly FRONT HALF — everything that is independent of how pi consumes the definition (a per-invoke
 * session for serving vs a resident one for chat).
 */
export interface AgentAssembly {
  config: FastagentConfig;
  configPath?: string;
  /**
   * The default "provider/modelId" spec (`--model` > `FASTAGENT_MODEL` > config), or undefined when the agent sets none:
   * it still opens, a session that records its model runs on it, and one that records none is refused with
   * `missing_model` at invoke.
   */
  modelSpec?: string;
  /** Absolute agent dir — definition, config and machinery live here, and it is the agent's working directory. */
  agentDir: string;
  /** What the agent works on and knows, resolved for this instance — the one answer every reader uses. */
  contexts: ResolvedContext[];
  /** Absolute state root (FASTAGENT_STATE_DIR > <agentDir>/.state). */
  stateRoot: string;
  /** The credential store and model registry every turn and every report reads ({@link agentModels}). */
  models: AgentModels;
  /** The full mounted tool surface (all coding tools + config.tools + discovered tools/). */
  tools: MountedTool[];
  toolNames: string[];
  indirectTools: IndirectTool[];
  toolCollisions: ToolCollision[];
  /** Env vars the mounted tools declared, by tool name — already asserted present by this function. */
  toolSecrets: Map<string, DeclaredSecret[]>;
}

export async function resolveAgentAssembly(
  dir: string,
  options: { model?: string } & CredentialSourceOptions = {},
): Promise<AgentAssembly> {
  const agentDir = resolveAgentDir(dir);
  const { config, path: configPath }: LoadedConfig = await loadConfig(agentDir);
  // Once per process, before the assembly: the locations are fixed until a restart, their content is re-read per turn.
  // This process runs the agent, so a repository with no checkout here is cloned, or its clone brought up to date in
  // place where git can do so without touching the agent's work, first; then resolved again as what is now on disk.
  for (const context of resolveContexts(agentDir, config.contexts)) {
    if (context.kind !== "github" || !context.clone) continue;
    const at = `github ${context.repo}${context.ref ? ` at ${context.ref}` : ""}`;
    const done = await cloneContext(context);
    if (done.outcome === "kept") {
      log.warn(
        `[fastagent] context "${context.name}": the clone in ${context.location} is kept as it is, ${done.reason}`,
      );
    } else {
      const said = { cloned: "cloned", updated: "brought up to date", current: "already up to date" }[done.outcome];
      log.info(`[fastagent] ${at}: ${said} in ${context.location}`);
    }
  }
  const contexts = resolveContexts(agentDir, config.contexts);
  for (const absent of contextsAbsentHere(agentDir, config.contexts)) {
    log.info(
      `[fastagent] context "${absent.name}" is a directory of the author's machine (${absent.path}): not on this ` +
        `host, and the agent is not told of it`,
    );
  }
  const modelSpec = resolveModelSpec(options.model, config);
  const { tools, toolNames, indirectTools, toolCollisions, toolFailures, toolSecrets } = await resolveAgentTools(
    config,
    agentDir,
  );
  // THE serving-path gate for tool declarations, in the order that costs the fewest round trips. A file that could
  // not be imported declares nothing, so its `secrets:` are missing from `toolSecrets` — gating secrets first would
  // report an incomplete set, and fixing the file could then reveal more missing values. Refuse the broken file
  // first and one pass reports every secret the definition actually wants.
  refuseBrokenDeclarations(toolFailures);
  // Both gates live here rather than inside resolveAgentTools, which `info` and `fastagent tool` call to REPORT on a
  // definition and must survive both faults; every path through this function is about to run ALL of the tools, so
  // no `owner`.
  //
  // DEFERRED tools gate too, deliberately: native discovery can activate one mid-turn, so "registered"
  // means "may run in this process" — letting it start would put the empty-credential failure back
  // inside a turn. An author who does not want that opts out per tool by not declaring.
  gateSecrets({ declared: toolSecrets, failures: [] });
  // The state root: sessions/channel state/schedule state derive from it (FASTAGENT_STATE_DIR moves it in one knob —
  // a container points it at its volume).
  const stateRoot = resolveStateRoot(agentDir);
  return {
    config,
    configPath,
    ...(modelSpec ? { modelSpec } : {}),
    agentDir,
    contexts,
    stateRoot,
    // Project-level by default (under `<agentDir>/.secrets`), with the global file behind it per provider.
    models: agentModels(agentDir, options),
    tools,
    toolNames,
    indirectTools,
    toolCollisions,
    toolSecrets,
  };
}

/**
 * L2 over a resolved front half: the ONE mapping from what the directory resolved to what the assembly runs on, for
 * both session shapes (the served agent and `chat`'s resident one). Two copies of it drifted once (#566, chat ran at
 * the wrong reasoning effort). `models` is the front's own, so the assembly runs on what the report describes.
 */
export function assembleFront(
  front: AgentAssembly,
  extra: { tools?: MountedTool[]; sessions?: PiSessionRecordStore } = {},
): Promise<{ assembly: PiAssembly; definition: LoadedDefinition }> {
  return assemblePiFromDefinition(front.agentDir, {
    ...(front.modelSpec ? { model: front.modelSpec } : {}),
    thinkingLevel: front.config.thinkingLevel,
    tools: extra.tools ?? front.tools,
    contexts: front.contexts,
    models: front.models,
    ...(extra.sessions ? { sessions: extra.sessions } : {}),
  });
}

/**
 * The models `createPiAgentFromDir(dir, { authPath })` could run now, as a picker shows them (spec, name, the thinking
 * levels a session on it accepts, context window), sorted by spec: the agent's registry (pi's built-ins, its
 * `models.json`, and what its `extensions/` declare) filtered to the providers whose credentials are configured. The
 * directory needs no model set, and the same directory and credential layers as the opener apply, so a listed spec
 * authenticates there. Configuration is checked, not validity: no OAuth token is refreshed and no provider is called.
 * A Sign in with ChatGPT on `openai` lists the account's own models (openai-account-models.ts), not pi's built-ins.
 *
 * `warn` reaches the credential store. An unreadable or corrupt credentials file otherwise reads as "nothing
 * configured", so a client that must not show that as an empty list passes a sink that throws. A ChatGPT sign-in that
 * carries no catalog is a normal, recoverable state (signed in before the catalog was read), not that: it is logged,
 * never sent to `warn`, so a throwing sink does not fail the whole listing for it.
 */
export async function availableModelsFromDir(
  dir: string,
  options: FastagentAuthOptions & CredentialSourceOptions = {},
): Promise<ModelDescriptor[]> {
  const environment = agentModels(resolveAgentDir(dir), options);
  const available = await (await environment.runtime()).getAvailable();
  const missing = missingAccountModels(await environment.credentials.read(OPENAI_PROVIDER));
  if (missing) log.warn(missing);
  return describeModels(available);
}

/**
 * Refresh the agent's model catalog (`<agent dir>/models-store.json`) with the credentials
 * `createPiAgentFromDir(dir, { authPath })` would use, so a model released after the installed pi appears in
 * {@link availableModelsFromDir} and runs. Only providers those credentials authenticate are fetched (pi asks pi.dev
 * for no other). Nothing refreshes it on its own. The file is part of the definition: commit it, and it ships with a
 * deploy, so the deployed agent knows the same models without a network call.
 *
 * Rejects, naming each provider that failed, when the refresh fails, outlasts 15 seconds or `PI_OFFLINE` is set, and
 * when the credentials authenticate no provider at all.
 */
export function refreshModelCatalog(
  dir: string,
  options: FastagentAuthOptions & CredentialSourceOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  return refreshModelCatalogOver(dir, options);
}

/** {@link refreshModelCatalog} against another catalog server. Not public: a test seam. */
export async function refreshModelCatalogOver(
  dir: string,
  options: FastagentAuthOptions & CredentialSourceOptions & { signal?: AbortSignal },
  catalogBaseUrl?: string,
): Promise<void> {
  const agentDir = resolveAgentDir(dir);
  const { credentials } = agentModels(agentDir, options);
  await refreshCatalog(
    join(agentDir, AGENT_MODEL_CATALOG_FILE),
    (catalogFile) =>
      createPiModelRuntime({
        agentDir,
        credentials,
        catalogFile,
        ...(catalogBaseUrl ? { catalogBaseUrl } : {}),
      }),
    options.signal ? { signal: options.signal } : {},
  );
}

/**
 * Refresh the MACHINE's model catalog (`~/.fastagent/models-store.json`), which every agent here reads under its own,
 * so one refresh serves them all and no file is written into any agent. Credentials resolve as for
 * {@link refreshModelCatalog} without a directory: `credentialStore`, else `authPath`, else the global credentials file;
 * the environment applies either way. Rejects for the same reasons. The file never ships with a deploy.
 */
export function refreshMachineModelCatalog(
  options: FastagentAuthOptions & CredentialSourceOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  return refreshMachineModelCatalogOver(options);
}

/** {@link refreshMachineModelCatalog} against another catalog server. Not public: a test seam. */
export async function refreshMachineModelCatalogOver(
  options: FastagentAuthOptions & CredentialSourceOptions & { signal?: AbortSignal },
  catalogBaseUrl?: string,
): Promise<void> {
  const { credentials } = agentModels(undefined, options);
  await refreshCatalog(
    globalCatalogPath(),
    (catalogFile) =>
      machineModelRuntime({
        credentials,
        catalogFile,
        ...(catalogBaseUrl ? { catalogBaseUrl } : {}),
      }),
    options.signal ? { signal: options.signal } : {},
  );
}

/** "Point at a directory → agent": `dir` is the agent directory; load the config, resolve model and tools, then L2. */
export async function createPiAgentFromDir(
  dir: string,
  options: CreatePiAgentFromDirOptions = {},
): Promise<{
  agent: Agent;
  definition: LoadedDefinition;
  config: FastagentConfig;
  configPath?: string;
  /** The default "provider/modelId" spec, or undefined when the agent sets none ({@link AgentAssembly.modelSpec}). */
  modelSpec?: string;
  /** Absolute agent dir in use — channels/tools/prompt come from here, and it is the agent's working directory. */
  agentDir: string;
  /** What the agent works on and knows, resolved for this instance. */
  contexts: ResolvedContext[];
  /** Absolute state root in use (FASTAGENT_STATE_DIR > <agentDir>/.state) — the ChannelContext's stateRoot. */
  stateRoot: string;
  /** Absolute session store directory in use (for the startup report). */
  sessionsDir: string;
  /** The credential store and registry the agent runs on — what the startup report describes. */
  models: AgentModels;
  sessions: PiSessionRecordStore;
  /** The observation plane over this agent's sessions; present on every serve (a channel's stop command reaches the
   *  live run through it). Its boundary is wired only when {@link publishControl}. */
  sessionControl?: SessionControl;
  /** Whether that plane is also served as `/control/*` — `config.sessionControl`. */
  publishControl: boolean;
  /** What the serve publishes — `config.http`, handed to the assembly as-is (MountableAgent). */
  http?: HttpSurface;
  /** Non-default, active-by-default tool names in effect: config.tools + discovered tools/. */
  toolNames: string[];
  /** Mounted authored tools the model is not given up front, with how each is reached. */
  indirectTools: IndirectTool[];
  toolCollisions: ToolCollision[];
}> {
  const front = await resolveAgentAssembly(dir, options);
  const {
    config,
    configPath,
    modelSpec,
    agentDir,
    contexts,
    stateRoot,
    models,
    tools,
    toolNames,
    indirectTools,
    toolCollisions,
  } = front;
  // Every serve mounts the built-in `wake` tool: the agent's own follow-up work is a default capability, and a serve
  // is where the poller that honors it runs. A one-shot `invoke` has no poller, so nothing there would fire it.
  const mountedTools = withWakeTool(tools, stateRoot, !!options.serving);
  // An explicit value is made absolute HERE, once, by the rule every path override follows, so the directory made, the
  // store's root and the one reported are the same. Without one, the resolution every reader shares (config.ts), so a
  // serve and an `info` never report on different directories.
  const sessionsDir = resolveOverridePath(options.sessionsDir) ?? resolveSessionsDir(agentDir);
  await mkdir(sessionsDir, { recursive: true });
  const sessions = piSessionRecordStore({ dir: sessionsDir, cwd: agentDir });
  // Skills are definition-only (the agent is its directory), so dev mirrors deployment exactly.
  const { assembly, definition } = await assembleFront(front, { tools: mountedTools, sessions });
  // The hub is wired HERE because the store is created here (an external `createPiSessionControl` cannot exist before
  // the store does).
  const caller = options.observer;
  // TWO decisions, not one. The hub is in-process bookkeeping over the run observer: a serve gets it unconditionally,
  // because `/stop` in a chat is an ordinary thing to ask for and reaching the live run is the only way to answer it.
  // Publishing `/control/*` — steer, rewrite, delete, unauthenticated at whatever URL this serves on — is the
  // separate decision `config.sessionControl` makes, and it is the only one that also wires the boundary.
  const publish = options.sessionControl ?? config.sessionControl === true;
  const wantControl = publish || options.serving === true;
  let hub: ReturnType<typeof createPiSessionControl> | undefined;
  if (wantControl) {
    // The plane resolves the registry and the default pair through the SAME function a turn's binding does, at each
    // use (the definition's extensions can change both). Resolved once here as well, only when the boundary is wired,
    // so a default model that does not resolve stops the open rather than the first control call.
    if (publish) await assembly.engine();
    const boundary = publish
      ? {
          lease: assembly.lease,
          sessionFactory: assembly.sessionFactory,
          models: assembly.modelRuntime,
          defaultModel: (registry: Models) => (modelSpec ? resolveModel(registry, modelSpec) : undefined),
          thinkingLevel: assembly.thinkingLevel,
        }
      : undefined;
    hub = createPiSessionControl({
      sessions,
      boundary,
      // What a client offers is what a turn WOULD run, which since this agent inherits its machine is not the
      // definition alone. Built through the same resource posture the turn uses, so the menu cannot list a name
      // the prompt would not expand — a second reading of "which skills exist" is how those two come to disagree.
      commands: () =>
        agentCommands(agentDir, contexts, {
          extensionPaths: assembly.extensionPaths,
          modelRuntime: assembly.createModelRuntime,
        }),
      // The caller tap's boundary-event half: state_changed/compaction_* originate in the hub and never cross the
      // data plane's observer seam.
      tap: caller ? (session, event) => caller(session, event) : undefined,
    });
  }
  const observer: SessionObserver | undefined = hub
    ? caller
      ? (session, event, run) => {
          hub.observer(session, event, run);
          caller(session, event, run);
        }
      : hub.observer
    : caller;
  const agent = agentOf(assembly, observer);
  return {
    agent,
    definition,
    sessions,
    sessionControl: hub?.control,
    publishControl: publish,
    http: config.http,
    agentDir,
    contexts,
    config,
    configPath,
    ...(modelSpec ? { modelSpec } : {}),
    stateRoot,
    sessionsDir,
    models,
    toolNames,
    indirectTools,
    toolCollisions,
  };
}
