/**
 * Open a definition directory into an agent — the single opener BOTH `fastagent dev` and
 * `fastagent start` drive (despite the file name, not dev-only).
 *
 * A thin command-posture composition over L2 `createPiAgentFromDefinition`: open the directory →
 * resolve model (flag > env > config) and tools (append-after-defaults) → pick session storage →
 * call L2. dev and start share the SAME assembly here (what you iterate is what you serve); they
 * differ only at the CLI — dev watches and uses the in-tree sessions default, start runs without
 * watch and can point sessions at a mounted volume.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "../../agent.ts";
import { type FastagentConfig, type LoadedConfig, loadConfig, resolveModelSpec } from "./config.ts";
import { createPiAgentFromDefinition, resolveWorkspaceTools } from "./create.ts";
import { type LoadedDefinition, ensureStateDirSelfIgnored } from "./definition.ts";
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
  const sessionsDir = options.sessionsDir ?? join(dir, ".fastagent", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  // Self-ignore only the default in-tree state dir. An explicit sessionsDir is the operator's path
  // (e.g. a mounted volume) — never write our `.gitignore` into it.
  if (!options.sessionsDir) await ensureStateDirSelfIgnored(join(dir, ".fastagent"));
  const { agent, definition } = await createPiAgentFromDefinition(dir, {
    model: modelSpec,
    tools,
    // Skills are definition-only (the agent is its folder), so dev mirrors deployment exactly.
    sessions: jsonlSessionStore({ dir: sessionsDir, cwd: dir }),
  });
  return { agent, definition, config, configPath, modelSpec, sessionsDir, toolNames, toolCollisions };
}
