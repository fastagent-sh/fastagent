/**
 * Open a definition directory into an agent — the single agent opener BOTH `fastagent dev` and
 * `fastagent start` drive.
 *
 * A thin command-posture composition over L2 `createPiAgentFromDefinition`: open the directory →
 * resolve model (flag > env > config) and tools (append-after-defaults) → pick session storage →
 * call L2. dev and start share the SAME assembly here (what you iterate is what you serve); they
 * differ only at the CLI — dev watches and uses the in-tree sessions default, start runs without
 * watch and can point sessions at a mounted volume.
 */
import { mkdir } from "node:fs/promises";
import type { Agent } from "../../agent.ts";
import {
  type FastagentConfig,
  type LoadedConfig,
  defaultSessionsDir,
  loadConfig,
  resolveAuthPath,
  resolveModelSpec,
} from "./config.ts";
import { resolveStateRoot, resolvePlacement } from "../../paths.ts";
import type { SessionControl } from "../../session.ts";
import { createPiAgentFromDefinition, resolveAgentTools } from "./create.ts";
import type { SessionObserver } from "./invoke.ts";
import { type PiBoundaryWiring, createPiSessionControl } from "./session-control.ts";
import type { PiSessionReader, PiSessionStore } from "./sessions.ts";
import { withWakeTool } from "./wake-tool.ts";
import type { ModuleLoadFailure } from "../../loader.ts";
import type { LoadedDefinition } from "./definition.ts";
import { jsonlSessionStore } from "./sessions.ts";
import type { ToolCollision } from "./tool.ts";
import type { MountedTool } from "./tool.ts";

export interface CreatePiAgentFromDirOptions {
  /** Model spec override (e.g. the CLI --model flag). Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
  /**
   * Session store directory. Default `<agentDir>/.state/sessions` (machine state). `start`
   * overrides it (--sessions-dir / FASTAGENT_SESSIONS_DIR / a mounted volume) so production continuity
   * survives redeploys.
   */
  sessionsDir?: string;
  /**
   * Credentials file override. Default `<agentDir>/.secrets/auth.json` (project-level, under the
   * `.secrets/`). Override via --auth-path / FASTAGENT_AUTH_PATH; point it at
   * the global `~/.fastagent/.secrets/auth.json` to share one credential across projects.
   */
  authPath?: string;
  /**
   * This is a long-running SERVE (`dev`/`start`), where the scheduler poller runs — so a self-scheduled
   * wake-up is actually honored. One-shot entries (`invoke`/`fire`) leave it off (they exit after the turn
   * and never poll). The built-in `wake` tool mounts only when this is set AND `config.selfSchedule` is on.
   */
  serving?: boolean;
  /** Assemble the session control plane over this agent's session store and return it as
   *  {@link sessionControl} — the store is created inside this opener, so the hub must be wired
   *  here too (an external `createPiSessionControl` cannot exist before the store does).
   *  Default: `config.sessionControl` AND {@link serving} — the config key means "serve the control
   *  plane", so one-shot commands (invoke/fire) do not assemble an unused hub. Pass explicitly to
   *  override either way. */
  sessionControl?: boolean;
  /** Additional raw tap with the FULL vocabulary: run events composed after the
   *  {@link sessionControl} hub's observer, plus the hub's own boundary-mutation events
   *  (`state_changed`/`compaction_*`) via the hub's tap. TRUSTED seam: since Phase 2a an observer
   *  receives each run's live modulation handles (see `SessionObserver`) — for read-only consumers
   *  use the hub's `events()` stream instead. */
  observer?: SessionObserver;
}

/**
 * The agent assembly FRONT HALF — everything that is independent of how pi consumes the
 * definition (transient harness for serving vs resident AgentSession for chat / session control):
 * placement resolution → config → model spec → the full tool surface ({@link resolveAgentTools} — the
 * ONE place it is computed) → state root → auth path. Both {@link createPiAgentFromDir} and the
 * session builder (session-builder.ts) consume this, so THESE inputs cannot drift between the two
 * consumption shapes. (Definition loading and prompt assembly stay per-consumer: serving re-reads
 * them live per invoke, the session builder snapshots at startup and lets pi append skills/env.)
 */
export interface AgentAssembly {
  config: FastagentConfig;
  configPath?: string;
  /** The resolved "provider/modelId" spec in use. */
  modelSpec: string;
  /** Absolute agent dir — definition + config + machinery live here (resolvePlacement().agentDir). */
  agentDir: string;
  /** Absolute workspace — the agent's cwd and the start of the ②-context walk: the agent dir's parent
   *  when the agent sits inside it, the agent dir ITSELF when you point at the agent. */
  workspace: string;
  /** Absolute state root (FASTAGENT_STATE_DIR > <agentDir>/.state). */
  stateRoot: string;
  /** Absolute credentials file (--auth-path/authPath option > FASTAGENT_AUTH_PATH > <agentDir>/.secrets/auth.json). */
  authPath: string;
  /** The full mounted tool surface (config.tools + discovered tools/, search_tools applied). */
  tools: MountedTool[];
  toolNames: string[];
  deferredToolNames: string[];
  toolCollisions: ToolCollision[];
  toolFailures: ModuleLoadFailure[];
}

export async function resolveAgentAssembly(
  dir: string,
  options: { model?: string; authPath?: string } = {},
): Promise<AgentAssembly> {
  // Placement is structural (resolvePlacement): the AGENT DIR carries definition + config + machinery;
  // its parent — the WORKSPACE — is what the agent works on: its cwd and the start of the ②-context
  // walk (that is where it reads the project's AGENTS.md from).
  const { agentDir, workspace } = resolvePlacement(dir);
  const { config, path: configPath }: LoadedConfig = await loadConfig(agentDir);
  const modelSpec = resolveModelSpec(options.model, config);
  if (!modelSpec) {
    throw new Error(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
    );
  }
  const { tools, toolNames, deferredToolNames, toolCollisions, toolFailures } = await resolveAgentTools(
    config,
    agentDir,
  );
  // The state root: sessions/channel state/schedule state derive from it (FASTAGENT_STATE_DIR moves it
  // in one knob — a container points it at its volume); the finer overrides below still win.
  const stateRoot = resolveStateRoot(agentDir);
  // The credentials file: project-level by default (under `<agentDir>/.secrets`); only resolved here, never
  // created (a missing file reads as not-configured — `fastagent login` creates it).
  const authPath = resolveAuthPath(agentDir, options.authPath);
  return {
    config,
    configPath,
    modelSpec,
    agentDir,
    workspace,
    stateRoot,
    authPath,
    tools,
    toolNames,
    deferredToolNames,
    toolCollisions,
    toolFailures,
  };
}

/**
 * "Point at a directory → agent": resolve the placement (`dir` may be either end — the workspace or
 * the agent dir itself), load the config, resolve model and tools, then L2. Throws a clear error when
 * no model source is set (fail visibly at startup). Returns everything an entry point needs to report
 * what it assembled.
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
  /** The session store in use — also a {@link PiSessionReader}. */
  sessions: PiSessionStore & PiSessionReader;
  /** The observation plane over this agent's sessions; present iff `options.sessionControl`. */
  sessionControl?: SessionControl;
  /** Non-default, active-by-default tool names in effect: config.tools + discovered tools/. Each name
   *  lives in exactly one report slot — deferred names are in {@link deferredToolNames} instead. */
  toolNames: string[];
  /** Tools registered but not initially active (deferred) — activated via search_tools. */
  deferredToolNames: string[];
  toolCollisions: ToolCollision[];
  /** `tools/` files that failed to import — skipped, reported by the caller, never fatal. */
  toolFailures: ModuleLoadFailure[];
}> {
  const {
    config,
    configPath,
    modelSpec,
    agentDir,
    workspace,
    stateRoot,
    authPath,
    tools,
    toolNames,
    deferredToolNames,
    toolCollisions,
    toolFailures,
  } = await resolveAgentAssembly(dir, options);
  // Mount the built-in `wake` tool only when BOTH: this is a long-running serve (the poller honors it) AND
  // the author opted into self-scheduling (config.selfSchedule). The agent's own `wake` wins if defined.
  const mountedTools = withWakeTool(tools, stateRoot, !!options.serving && !!config.selfSchedule);
  const sessionsDir = options.sessionsDir ?? defaultSessionsDir(stateRoot);
  await mkdir(sessionsDir, { recursive: true });
  const sessions = jsonlSessionStore({ dir: sessionsDir, cwd: workspace });
  // The hub is wired HERE because the store is created here: chicken-and-egg otherwise (the hub
  // needs the store; the agent needs the hub's observer). Boundary parts (models/factory/lease)
  // only exist after the assembly below — the hub takes them as a lazy thunk, filled by the
  // assembly's onAssembly callback (assembly completes before this function returns, so every
  // dispatch sees them). An extra caller observer composes after the hub's (TRUSTED seam).
  let boundaryParts: PiBoundaryWiring | undefined;
  const caller = options.observer;
  const wantControl = options.sessionControl ?? (config.sessionControl === true && options.serving === true);
  const hub = wantControl
    ? createPiSessionControl({
        sessions,
        boundary: () => boundaryParts,
        // The caller tap's boundary-event half: state_changed/compaction_* originate in the hub
        // and never cross the data plane's observer seam — without this, an audit tap wired here
        // would miss exactly the mutations it most needs to see (set_model).
        tap: caller ? (session, event) => caller(session, event) : undefined,
      })
    : undefined;
  const observer: SessionObserver | undefined = hub
    ? caller
      ? (session, event, run) => {
          hub.observer(session, event, run);
          caller(session, event, run);
        }
      : hub.observer
    : caller;
  const { agent, definition } = await createPiAgentFromDefinition(agentDir, {
    model: modelSpec,
    thinkingLevel: config.thinkingLevel,
    cwd: workspace,
    tools: mountedTools,
    authPath,
    // Skills are definition-only (the agent is its directory), so dev mirrors deployment exactly.
    sessions,
    observer,
    onAssembly: hub
      ? (parts) => {
          boundaryParts = {
            lease: parts.lease,
            models: parts.models,
            harnessFactory: parts.harnessFactory,
            defaults: parts.defaults,
          };
        }
      : undefined,
  });
  return {
    agent,
    definition,
    sessions,
    sessionControl: hub?.control,
    agentDir,
    workspace,
    config,
    configPath,
    modelSpec,
    stateRoot,
    sessionsDir,
    authPath,
    toolNames,
    deferredToolNames,
    toolCollisions,
    toolFailures,
  };
}
