/**
 * Open a definition directory into an agent — the single workspace opener BOTH `fastagent dev` and
 * `fastagent start` drive.
 *
 * A thin command-posture composition over L2 `createPiAgentFromDefinition`: open the directory →
 * resolve model (flag > env > config) and tools (append-after-defaults) → pick session storage →
 * call L2. dev and start share the SAME assembly here (what you iterate is what you serve); they
 * differ only at the CLI — dev watches and uses the in-tree sessions default, start runs without
 * watch and can point sessions at a mounted volume.
 */
import { mkdir } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Agent } from "../../agent.ts";
import {
  type FastagentConfig,
  type LoadedConfig,
  defaultSessionsDir,
  loadConfig,
  resolveAgentDir,
  resolveAuthPath,
  resolveModelSpec,
  resolveStateRoot,
} from "./config.ts";
import type { SessionControl } from "../../session.ts";
import { createPiAgentFromDefinition, resolveWorkspaceTools } from "./create.ts";
import type { SessionObserver } from "./invoke.ts";
import { createPiSessionControl } from "./session-control.ts";
import type { PiSessionReader, PiSessionStore } from "./sessions.ts";
import { withWakeTool } from "./wake-tool.ts";
import type { ModuleLoadFailure } from "../../loader.ts";
import { type LoadedDefinition, ensureStateRootSelfIgnored } from "./definition.ts";
import { jsonlSessionStore } from "./sessions.ts";
import type { ToolCollision } from "./tool.ts";

export interface CreatePiAgentFromWorkspaceOptions {
  /** Model spec override (e.g. the CLI --model flag). Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
  /**
   * Session store directory. Default `<dir>/.fastagent/sessions` (gitignored machine state). `start`
   * overrides it (--sessions-dir / FASTAGENT_SESSIONS_DIR / a mounted volume) so production continuity
   * survives redeploys.
   */
  sessionsDir?: string;
  /**
   * Credentials file override. Default `<dir>/.fastagent/auth.json` (project-level, gitignored under
   * the same `*`-ignored `.fastagent`). Override via --auth-path / FASTAGENT_AUTH_PATH; point it at
   * `~/.fastagent/auth.json` to share one credential across projects.
   */
  authPath?: string;
  /**
   * This is a long-running SERVE (`dev`/`start`), where the scheduler poller runs — so a self-scheduled
   * wake-up is actually honored. One-shot entries (`invoke`/`fire`) leave it off (they exit after the turn
   * and never poll). The built-in `wake` tool mounts only when this is set AND `config.selfSchedule` is on.
   */
  serving?: boolean;
  /** Assemble the session control plane over this workspace's session store and return it as
   *  {@link sessionControl} — the store is created inside this opener, so the hub must be wired
   *  here too (an external `createPiSessionControl` cannot exist before the store does). */
  sessionControl?: boolean;
  /** Additional raw tap, composed AFTER the {@link sessionControl} hub's observer. TRUSTED seam:
   *  since Phase 2a an observer receives each run's live modulation handles (see
   *  `SessionObserver`) — for read-only consumers use the hub's `events()` stream instead. */
  observer?: SessionObserver;
}

/**
 * The workspace assembly FRONT HALF — everything that is independent of how pi consumes the
 * definition (transient harness for serving vs resident AgentSession for chat / session control):
 * config → model spec → agentDir → the full tool surface ({@link resolveWorkspaceTools} — the ONE
 * place it is computed) → state root → auth path. Both {@link createPiAgentFromWorkspace} and the
 * session builder (session-builder.ts) consume this, so THESE inputs cannot drift between the two
 * consumption shapes. (Definition loading and prompt assembly stay per-consumer: serving re-reads
 * them live per invoke, the session builder snapshots at startup and lets pi append skills/env.)
 */
export interface WorkspaceAssembly {
  config: FastagentConfig;
  configPath?: string;
  /** The resolved "provider/modelId" spec in use. */
  modelSpec: string;
  /** Absolute agent-definition dir (config.agentDir resolved against dir; = dir when unset). */
  agentDir: string;
  /** Absolute state root (FASTAGENT_STATE_DIR > <dir>/.fastagent). */
  stateRoot: string;
  /** Absolute credentials file (--auth-path/authPath option > FASTAGENT_AUTH_PATH > <stateRoot>/auth.json). */
  authPath: string;
  /** The full mounted tool surface (config.tools + discovered tools/, search_tools applied). */
  tools: AgentTool[];
  toolNames: string[];
  deferredToolNames: string[];
  toolCollisions: ToolCollision[];
  toolFailures: ModuleLoadFailure[];
}

export async function resolveWorkspaceAssembly(
  dir: string,
  options: { model?: string; authPath?: string } = {},
): Promise<WorkspaceAssembly> {
  const { config, path: configPath }: LoadedConfig = await loadConfig(dir);
  const modelSpec = resolveModelSpec(options.model, config);
  if (!modelSpec) {
    throw new Error(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
    );
  }
  // The run root is `dir` (cwd — where config lives, whose AGENTS.md is ② context); the agent's own
  // surface (persona/skills/tools/channels) lives in `agentDir` (config.agentDir, or `dir` when flat).
  const agentDir = resolveAgentDir(dir, config);
  const { tools, toolNames, deferredToolNames, toolCollisions, toolFailures } = await resolveWorkspaceTools(
    config,
    agentDir,
    dir,
  );
  // The state root: auth/sessions/channel state all derive from it, so FASTAGENT_STATE_DIR moves the
  // whole machine-state home in one knob (a container mounts one volume); the finer overrides below
  // still win for their specific path.
  const stateRoot = resolveStateRoot(dir);
  // The credentials file: project-level by default (under the state root); only resolved here, never
  // created (a missing file reads as not-configured — `fastagent login` creates it).
  const authPath = resolveAuthPath(dir, options.authPath);
  // Self-ignore the state root iff it lands in-tree — which covers everything under it (sessions, auth,
  // every channel's `channels/<kind>` home). HERE, not in the serving opener: every consumer of this
  // assembly can WRITE under the state root (serving: sessions/channels; the session builder: pi's
  // `/login` writing auth.json), so resolving a workspace's state root must make it leak-safe.
  await ensureStateRootSelfIgnored(dir, stateRoot);
  return {
    config,
    configPath,
    modelSpec,
    agentDir,
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
 * "Point at a workspace → agent": load the config, resolve model and tools, then L2. Throws a clear
 * error when no model source is set (fail visibly at startup). Returns everything an entry point needs
 * to report what it assembled.
 */
export async function createPiAgentFromWorkspace(
  dir: string,
  options: CreatePiAgentFromWorkspaceOptions = {},
): Promise<{
  agent: Agent;
  definition: LoadedDefinition;
  config: FastagentConfig;
  configPath?: string;
  /** The resolved "provider/modelId" spec actually in use. */
  modelSpec: string;
  /** Absolute agent-definition dir in use (config.agentDir resolved against dir; = dir when unset). Channels/tools/persona come from here. */
  agentDir: string;
  /** Absolute state root in use (FASTAGENT_STATE_DIR > <dir>/.fastagent) — the ChannelContext's stateRoot. */
  stateRoot: string;
  /** Absolute session store directory in use (for the startup report). */
  sessionsDir: string;
  /** Absolute credentials file in use (for the startup report). */
  authPath: string;
  /** The session store in use — also a {@link PiSessionReader}. */
  sessions: PiSessionStore & PiSessionReader;
  /** The observation plane over this workspace's sessions; present iff `options.sessionControl`. */
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
    stateRoot,
    authPath,
    tools,
    toolNames,
    deferredToolNames,
    toolCollisions,
    toolFailures,
  } = await resolveWorkspaceAssembly(dir, options);
  // Mount the built-in `wake` tool only when BOTH: this is a long-running serve (the poller honors it) AND
  // the author opted into self-scheduling (config.selfSchedule). The workspace's own `wake` wins if defined.
  const mountedTools = withWakeTool(tools, stateRoot, !!options.serving && !!config.selfSchedule);
  const sessionsDir = options.sessionsDir ?? defaultSessionsDir(stateRoot);
  await mkdir(sessionsDir, { recursive: true });
  const sessions = jsonlSessionStore({ dir: sessionsDir, cwd: dir });
  // The hub is wired HERE because the store is created here: chicken-and-egg otherwise (the hub
  // needs the store; the agent needs the hub's observer). An extra caller observer composes after it.
  const hub = options.sessionControl ? createPiSessionControl({ sessions }) : undefined;
  const caller = options.observer;
  const observer: SessionObserver | undefined = hub
    ? caller
      ? (session, event) => {
          hub.observer(session, event);
          caller(session, event);
        }
      : hub.observer
    : caller;
  const { agent, definition } = await createPiAgentFromDefinition(agentDir, {
    model: modelSpec,
    thinkingLevel: config.thinkingLevel,
    cwd: dir,
    tools: mountedTools,
    authPath,
    // Skills are definition-only (the agent is its directory), so dev mirrors deployment exactly.
    sessions,
    observer,
  });
  return {
    agent,
    definition,
    sessions,
    sessionControl: hub?.control,
    agentDir,
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
