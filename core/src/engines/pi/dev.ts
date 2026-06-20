/**
 * Dev: open a workspace into an agent in AUTHORING posture (`fastagent dev`).
 *
 * `dev` is the authoring-time counterpart of `start` (production, `start.ts`). Both are thin
 * "openers" — open a source → resolve model/tools → inject K-wiring → call L2
 * `createPiAgentFromDefinition`. They are NOT ladder rungs (the reusable assembly ladder is
 * L0–L2 in create.ts/invoke.ts); they are command-posture compositions over L2. The two differ
 * only in their source and K defaults:
 *
 *   | concern  | dev (from workspace, here)            | start (from artifact, start.ts)        |
 *   |----------|----------------------------------------|-----------------------------------------|
 *   | model    | fastagent.config.ts (flag > env > cfg) | manifest.model (frozen at build)        |
 *   | tools    | loadConfig → resolveTools              | loadConfig → resolveTools (same)        |
 *   | skills   | definition-only (+ --global-skills)    | definition-only (artifact is the truth) |
 *   | sessions | jsonl under <ws>/.fastagent/sessions   | jsonl OUTSIDE the artifact              |
 *
 * dev keeps sessions under the workspace's own `.fastagent/` because the dev "artifact" is the
 * mutable workspace itself — restart-surviving local continuity, faithful to local pi. (start
 * deliberately differs: its artifact is immutable, so sessions live outside it — see start.ts.)
 *
 * Node composition-root module (IO policy, see definition.ts): loads config + sets up the
 * `.fastagent/` state dir on disk; the invoke path itself stays disk-free.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "../../agent.ts";
import type { FastagentConfig } from "./config.ts";
import { createPiAgentFromDefinition } from "./create.ts";
import { type LoadedDefinition, defaultGlobalSkillPaths, ensureStateDirSelfIgnored } from "./definition.ts";
import { jsonlSessionStore } from "./sessions.ts";
import type { ToolCollision } from "./tool.ts";
import { resolveWorkspace } from "./workspace.ts";

export interface CreatePiAgentFromWorkspaceOptions {
  /** Model spec override (e.g. the CLI --model flag). Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
  /**
   * Also load the machine's global skills (`~/.pi/agent/skills`, `~/.agents/skills`) on top of
   * the definition's own `skills/`. Default false = definition-only, so dev mirrors deployment.
   * This is an authoring-fidelity opt-in (e.g. `fastagent dev --global-skills`); to ship a global
   * skill, materialize it into the artifact (build --global-skills) — do not rely on this at deploy.
   */
  globalSkills?: boolean;
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
  /** Non-default tool names in effect: config.tools + discovered tools/. */
  toolNames: string[];
  /** Discovered tools dropped on a name clash with a default/config tool (surfaced, not silent). */
  toolCollisions: ToolCollision[];
}> {
  // M side (model + tools + config) is the shared workspace resolution; dev adds only K + state.
  const { config, configPath, modelSpec, model, tools, toolNames, toolCollisions } = await resolveWorkspace(dir, {
    model: options.model,
  });
  // The dev opener owns workspace state: .fastagent/ (machine state — gitignored, deletable,
  // rebuildable) is created HERE, not in the CLI, so library callers get the same
  // self-gitignored dir (vite/next-style).
  const stateDir = join(dir, ".fastagent");
  await mkdir(stateDir, { recursive: true });
  await ensureStateDirSelfIgnored(stateDir);
  const { agent, definition } = await createPiAgentFromDefinition(dir, {
    model,
    tools,
    // Definition-only by default (the agent is its folder); globals are an explicit
    // authoring-fidelity opt-in, never the deploy path (see create.ts ladder rule 2 + core-design §6).
    skillPaths: options.globalSkills ? defaultGlobalSkillPaths() : [],
    // Sessions persist under the state dir: `fastagent dev` restarts keep conversations —
    // faithful to local pi, which persists sessions too.
    sessions: jsonlSessionStore({ dir: join(stateDir, "sessions"), cwd: dir }),
  });
  return { agent, definition, config, configPath, modelSpec, toolNames, toolCollisions };
}
