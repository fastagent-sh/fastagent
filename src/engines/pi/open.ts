/**
 * Open a definition directory into an agent — the single agent opener BOTH `fastagent dev` and `fastagent start`
 * drive.
 */
import { mkdir } from "node:fs/promises";
import type { Agent } from "../../agent.ts";
import {
  type FastagentConfig,
  type LoadedConfig,
  loadConfig,
  resolveAuthFallback,
  resolveAuthPath,
  resolveModelSpec,
} from "./config.ts";
import { resolveSessionsDir, resolveStateRoot, resolvePlacement } from "../../paths.ts";
import type { AgentCommand, SessionControl } from "../../session.ts";
import { agentOf, assemblePiFromDefinition, resolveAgentTools } from "./create.ts";
import type { SessionObserver } from "./turn-kit.ts";
import { createPiSessionControl } from "./session-control.ts";
import { withWakeTool } from "./wake-tool.ts";
import { refuseBrokenDeclarations } from "../../loader.ts";
import { type LoadedDefinition, loadAgentSkills } from "./definition.ts";
import { reportFindingsIfChanged } from "./report.ts";
import { readMachine, withMachine } from "./machine.ts";
import { type PiSessionRecordStore, piSessionRecordStore } from "./session-store.ts";
import type { ToolCollision, MountedTool } from "./tool.ts";
import type { DeclaredSecret } from "../../declared-secrets.ts";
import { gateSecrets } from "../../secrets-gate.ts";

/**
 * The names a `/` composer completes: this agent's skills — the definition's, plus the ones its machine lends
 * (machine.ts) — and the machine's prompt templates.
 *
 * `source` says how a name is INVOKED, which is the one thing a client needs from it: a `skill` is sent as
 * `/skill:<name>`, a `prompt` as `/<name>` (docs/design/session-control.md §5.1.1).
 *
 * The definition is read live, like every turn reads it; the machine is the process's one read, the same snapshot a
 * bound session runs on, so the menu cannot offer a name the next prompt would not expand.
 */
export async function agentCommands(agentDir: string, workspace: string): Promise<AgentCommand[]> {
  const own = await loadAgentSkills(agentDir, { cwd: workspace });
  // A skill whose frontmatter broke simply is not in `skills` — it would vanish from the composer with no signal.
  reportFindingsIfChanged(own.dir, own);
  const machine = await readMachine(workspace);
  return [
    ...withMachine(own.skills, machine.skills).map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: "skill",
    })),
    ...machine.prompts.map((prompt) => ({
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
   * `FASTAGENT_STATE_DIR` (see {@link resolveSessionsDir}).
   */
  sessionsDir?: string;
  /** Credentials file override. */
  authPath?: string;
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
  /** The resolved "provider/modelId" spec in use. */
  modelSpec: string;
  /** Absolute agent dir — definition + config + machinery live here (resolvePlacement().agentDir). */
  agentDir: string;
  /** Absolute workspace — the agent's cwd and the start of the ②-context walk. */
  workspace: string;
  /** Absolute state root (FASTAGENT_STATE_DIR > <agentDir>/.state). */
  stateRoot: string;
  /** Absolute credentials file (`authPath` option > FASTAGENT_AUTH_PATH > <agentDir>/.secrets/auth.json). */
  authPath: string;
  /** Where a provider `authPath` does not have is read from instead ({@link resolveAuthFallback}); unset when an
   *  explicit path was named. */
  fallbackAuthPath?: string;
  /** The full mounted tool surface (all coding tools + config.tools + discovered tools/, search_tools applied). */
  tools: MountedTool[];
  toolNames: string[];
  deferredToolNames: string[];
  toolCollisions: ToolCollision[];
  /** Env vars the mounted tools declared, by tool name — already asserted present by this function. */
  toolSecrets: Map<string, DeclaredSecret[]>;
}

export async function resolveAgentAssembly(
  dir: string,
  options: { model?: string; authPath?: string } = {},
): Promise<AgentAssembly> {
  // Placement is structural (resolvePlacement): the AGENT DIR carries definition + config + machinery; its parent.
  const { agentDir, workspace } = resolvePlacement(dir);
  const { config, path: configPath }: LoadedConfig = await loadConfig(agentDir);
  const modelSpec = resolveModelSpec(options.model, config);
  if (!modelSpec) {
    throw new Error(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
    );
  }
  const { tools, toolNames, deferredToolNames, toolCollisions, toolFailures, toolSecrets } = await resolveAgentTools(
    config,
    agentDir,
    workspace,
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
  // DEFERRED tools gate too, deliberately: `search_tools` can activate one mid-turn, so "registered"
  // means "may run in this process" — letting it start would put the empty-credential failure back
  // inside a turn. An author who does not want that opts out per tool by not declaring.
  gateSecrets({ declared: toolSecrets, failures: [] });
  // The state root: sessions/channel state/schedule state derive from it (FASTAGENT_STATE_DIR moves it in one knob —
  // a container points it at its volume).
  const stateRoot = resolveStateRoot(agentDir);
  // The credentials file: project-level by default (under `<agentDir>/.secrets`).
  const authPath = resolveAuthPath(agentDir, options.authPath);
  const fallbackAuthPath = resolveAuthFallback(options.authPath);
  return {
    config,
    configPath,
    modelSpec,
    agentDir,
    workspace,
    stateRoot,
    authPath,
    ...(fallbackAuthPath !== undefined ? { fallbackAuthPath } : {}),
    tools,
    toolNames,
    deferredToolNames,
    toolCollisions,
    toolSecrets,
  };
}

/**
 * "Point at a directory → agent": resolve the placement (`dir` may be either end — the workspace or the agent dir
 * itself), load the config, resolve model and tools, then L2.
 */
export async function createPiAgentFromDir(
  dir: string,
  options: CreatePiAgentFromDirOptions = {},
): Promise<{
  agent: Agent;
  definition: LoadedDefinition;
  config: FastagentConfig;
  configPath?: string;
  /** The resolved "provider/modelId" spec actually in use. */
  modelSpec: string;
  /** Absolute agent dir in use — channels/tools/persona come from here. */
  agentDir: string;
  /** Absolute workspace in use — the agent's cwd: ALWAYS the directory that was pointed at. */
  workspace: string;
  /** Absolute state root in use (FASTAGENT_STATE_DIR > <agentDir>/.state) — the ChannelContext's stateRoot. */
  stateRoot: string;
  /** Absolute session store directory in use (for the startup report). */
  sessionsDir: string;
  /** Absolute credentials file in use (for the startup report). */
  authPath: string;
  /** The second layer that file reads through ({@link AgentAssembly.fallbackAuthPath}) — the startup report names
   *  whichever layer the credential came from, so it needs both. */
  fallbackAuthPath?: string;
  sessions: PiSessionRecordStore;
  /** The observation plane over this agent's sessions; present on every serve (a channel's stop command reaches the
   *  live run through it). Its boundary is wired only when {@link publishControl}. */
  sessionControl?: SessionControl;
  /** Whether that plane is also served as `/control/*` — `config.sessionControl`. */
  publishControl: boolean;
  /**
   * Whether the agent schedules its own follow-up turns — read from the config, so a caller assembling a service does
   * not have to reach back into it (MountableAgent).
   */
  selfSchedule: boolean;
  /** The origins a browser may call this serve from; unset answers every one — `http.cors` (MountableAgent). */
  corsOrigins?: readonly string[];
  /** Whether to serve the data plane, `POST /invoke` — `http.invoke` (MountableAgent). */
  serveInvoke?: boolean;
  /** Whether to serve `POST /run` — `http.run`, which follows `http.invoke` when unset (MountableAgent). */
  serveRun?: boolean;
  /** Non-default, active-by-default tool names in effect: config.tools + discovered tools/. */
  toolNames: string[];
  /** Tools registered but not initially active (deferred) — activated via search_tools. */
  deferredToolNames: string[];
  toolCollisions: ToolCollision[];
}> {
  const {
    config,
    configPath,
    modelSpec,
    agentDir,
    workspace,
    stateRoot,
    authPath,
    fallbackAuthPath,
    tools,
    toolNames,
    deferredToolNames,
    toolCollisions,
  } = await resolveAgentAssembly(dir, options);
  // Mount the built-in `wake` tool only when BOTH: this is a long-running serve (the poller honors it) AND the author
  // opted into self-scheduling (config.selfSchedule).
  const mountedTools = withWakeTool(tools, stateRoot, !!options.serving && !!config.selfSchedule);
  // An explicit value is used as given (the store resolves a relative one against the WORKSPACE); without one, the
  // resolution every reader shares (config.ts), so a serve and an `info` never report on different directories.
  const sessionsDir = options.sessionsDir ?? resolveSessionsDir(agentDir);
  await mkdir(sessionsDir, { recursive: true });
  const sessions = piSessionRecordStore({ dir: sessionsDir, cwd: workspace });
  const { assembly, definition } = await assemblePiFromDefinition(agentDir, {
    model: modelSpec,
    thinkingLevel: config.thinkingLevel,
    cwd: workspace,
    tools: mountedTools,
    authPath,
    ...(fallbackAuthPath !== undefined ? { fallbackAuthPath } : {}),
    // Skills are definition-only (the agent is its directory), so dev mirrors deployment exactly.
    sessions,
  });
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
    // The hub's surface is synchronous (`capabilities()` lists the allowed models), while building the registry reads
    // credentials and is not. Resolved only when the boundary is wired, so an ordinary serve does not pay for it.
    const boundary = publish
      ? await assembly.engine().then(({ modelRuntime, model }) => ({
          lease: assembly.lease,
          models: modelRuntime,
          sessionFactory: assembly.sessionFactory,
          defaults: { model, thinkingLevel: assembly.thinkingLevel },
        }))
      : undefined;
    hub = createPiSessionControl({
      sessions,
      boundary,
      // What a client offers is what a turn WOULD run, which since this agent inherits its machine is not the
      // definition alone. Built through the same resource posture the turn uses, so the menu cannot list a name
      // the prompt would not expand — a second reading of "which skills exist" is how those two come to disagree.
      commands: () => agentCommands(agentDir, workspace),
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
    selfSchedule: config.selfSchedule ?? false,
    ...(config.http?.cors ? { corsOrigins: config.http.cors } : {}),
    ...(config.http?.invoke !== undefined ? { serveInvoke: config.http.invoke } : {}),
    ...(config.http?.run !== undefined ? { serveRun: config.http.run } : {}),
    agentDir,
    workspace,
    config,
    configPath,
    modelSpec,
    stateRoot,
    sessionsDir,
    authPath,
    ...(fallbackAuthPath !== undefined ? { fallbackAuthPath } : {}),
    toolNames,
    deferredToolNames,
    toolCollisions,
  };
}
