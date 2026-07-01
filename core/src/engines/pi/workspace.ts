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
import type { Agent } from "../../agent.ts";
import {
  type FastagentConfig,
  type LoadedConfig,
  defaultProjectAuthPath,
  defaultProjectSessionsDir,
  loadConfig,
  resolveModelSpec,
} from "./config.ts";
import { createPiAgentFromDefinition, resolveWorkspaceTools } from "./create.ts";
import { type LoadedDefinition, ensureInTreeStateSelfIgnored } from "./definition.ts";
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
  /** Absolute session store directory in use (for the startup report). */
  sessionsDir: string;
  /** Absolute credentials file in use (for the startup report). */
  authPath: string;
  /** Non-default tool names in effect: config.tools + discovered tools/. */
  toolNames: string[];
  toolCollisions: ToolCollision[];
}> {
  const { config, path: configPath }: LoadedConfig = await loadConfig(dir);
  const modelSpec = resolveModelSpec(options.model, config);
  if (!modelSpec) {
    throw new Error(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
    );
  }
  const { tools, toolNames, toolCollisions } = await resolveWorkspaceTools(config, dir);
  const sessionsDir = options.sessionsDir ?? defaultProjectSessionsDir(dir);
  await mkdir(sessionsDir, { recursive: true });
  // The credentials file: project-level by default (its `.fastagent` dir is self-ignored below); only
  // READ here, so no mkdir (a missing file reads as not-configured — `fastagent login` creates it).
  const authPath = options.authPath ?? defaultProjectAuthPath(dir);
  // Self-ignore the in-tree `.fastagent` iff sessions OR auth actually lands under it (decided by path
  // location, not which option was passed; the single owner also skips the HOME-global dir).
  await ensureInTreeStateSelfIgnored(dir, sessionsDir, authPath);
  const { agent, definition } = await createPiAgentFromDefinition(dir, {
    model: modelSpec,
    tools,
    authPath,
    // Skills are definition-only (the agent is its folder), so dev mirrors deployment exactly.
    sessions: jsonlSessionStore({ dir: sessionsDir, cwd: dir }),
  });
  return { agent, definition, config, configPath, modelSpec, sessionsDir, authPath, toolNames, toolCollisions };
}
