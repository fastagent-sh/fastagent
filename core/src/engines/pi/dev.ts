/**
 * Open a definition directory into an agent — the single opener BOTH `fastagent dev` and
 * `fastagent start` drive (despite the file name, this is not dev-only).
 *
 * A thin command-posture composition over L2 `createPiAgentFromDefinition`: open the directory →
 * resolve model (flag > env > config) and tools (append-after-defaults) → pick session storage →
 * call L2. NOT a ladder rung (the reusable ladder is L0–L2 in create.ts/invoke.ts). dev and start
 * share the SAME assembly here — single source of truth, so what you iterate is what you serve;
 * they differ only at the CLI:
 *
 *   | concern  | dev (fastagent dev)                  | start (fastagent start)                |
 *   |----------|--------------------------------------|----------------------------------------|
 *   | watch    | yes (restart the worker on edits)    | no (stable process)                    |
 *   | sessions | <dir>/.fastagent/sessions (default)  | same default, overridable to a volume  |
 *   | posture  | authoring                            | production                             |
 *
 * There is no build/artifact: the directory IS the agent, run directly (model/http from
 * fastagent.config.ts, frozen by git). Sessions default under the definition's own `.fastagent/`
 * (restart-surviving local continuity, faithful to local pi); start can point them at a mounted
 * volume (sessionsDir) so a redeploy that replaces the directory does not wipe conversations.
 *
 * Node composition-root module (IO policy, see definition.ts): loads config + sets up the
 * session state dir on disk; the invoke path itself stays disk-free.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "../../agent.ts";
import { type FastagentConfig, type LoadedConfig, loadConfig, resolveModel, resolveModelSpec } from "./config.ts";
import { createPiAgentFromDefinition, resolveWorkspaceTools } from "./create.ts";
import { type LoadedDefinition, ensureStateDirSelfIgnored } from "./definition.ts";
import { createPiModels } from "./models.ts";
import { jsonlSessionStore } from "./sessions.ts";
import type { ToolCollision } from "./tool.ts";

export interface CreatePiAgentFromWorkspaceOptions {
  /** Model spec override (e.g. the CLI --model flag). Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
  /**
   * Session store directory. Default `<dir>/.fastagent/sessions` (machine state, gitignored).
   * `start` overrides it (--sessions-dir / FASTAGENT_SESSIONS_DIR / a mounted volume) so production
   * continuity survives redeploys; dev keeps the local default (restart-surviving, like local pi).
   */
  sessionsDir?: string;
}

/**
 * "Point at a workspace → agent": the workspace = definition folder + fastagent.config.ts (+ .env
 * handled by the process entry). Loads the config, resolves model (flag > env > config) and tools
 * (append-after-defaults), then L2. Throws a clear error when no model source is set (fail visibly
 * at startup). Returns everything an entry point needs to report what it assembled.
 *
 * Notably absent from the options by design: `model`/`tools` as objects (they come from the config
 * resolution — the whole point of this opener) and K/auth overrides (deployment backends are a
 * library-API concern; use L2/L1 — see create.ts ladder rule 2, KNOWN DEBT: re-cut when hosting lands).
 */
export async function createPiAgentFromWorkspace(
  dir: string,
  options: CreatePiAgentFromWorkspaceOptions = {},
): Promise<{
  agent: Agent;
  definition: LoadedDefinition;
  config: FastagentConfig;
  /** Config file path; undefined when running zero-config. */
  configPath?: string;
  /** The resolved "provider/modelId" spec actually in use. */
  modelSpec: string;
  /** Absolute session store directory in use (for the startup report). */
  sessionsDir: string;
  /** Non-default tool names in effect: config.tools + discovered tools/. */
  toolNames: string[];
  /** Discovered tools dropped on a name clash with a default/config tool (surfaced, not silent). */
  toolCollisions: ToolCollision[];
}> {
  const { config, path: configPath }: LoadedConfig = await loadConfig(dir);
  const modelSpec = resolveModelSpec(options.model, config);
  if (!modelSpec) {
    throw new Error(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
    );
  }
  // Discover tools/ and merge with pi defaults + config.tools (existing win) — the same resolution
  // start and `fastagent tool` use, so the dev server mounts exactly what gets served.
  const { tools, toolNames, toolCollisions } = await resolveWorkspaceTools(config, dir);
  // Sessions: default under the definition's own .fastagent/ (machine state — gitignored,
  // deletable). Created HERE (not the CLI), so library callers get the self-gitignored dir too
  // (vite/next-style). When start points sessionsDir outside (a volume), self-ignore that dir.
  const sessionsDir = options.sessionsDir ?? join(dir, ".fastagent", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await ensureStateDirSelfIgnored(options.sessionsDir ? sessionsDir : join(dir, ".fastagent"));
  const models = createPiModels();
  const { agent, definition } = await createPiAgentFromDefinition(dir, {
    models,
    model: resolveModel(models, modelSpec),
    tools,
    // Skills are definition-only (the agent is its folder) — no global/external mount, so dev
    // mirrors deployment exactly (see create.ts ladder rule 2 + core-design §6).
    sessions: jsonlSessionStore({ dir: sessionsDir, cwd: dir }),
  });
  return { agent, definition, config, configPath, modelSpec, sessionsDir, toolNames, toolCollisions };
}
