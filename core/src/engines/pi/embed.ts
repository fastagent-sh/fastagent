/**
 * Embed: open a workspace folder into an agent in PRODUCTION-EMBED posture (`createPiAgentForEmbed`).
 *
 * This is the blessed entry point for putting an agent inside an app you already have (a Next/Astro/
 * Hono route, a Slack/webhook worker). It is the third opener beside dev.ts (authoring) and start.ts
 * (standalone artifact), and it exists to close one specific gap: neither existing API gave BOTH the
 * workspace conveniences (config-driven model resolution + `tools/` discovery) AND K-axis injection.
 *
 *   | opener                         | reads config/discovers tools | K injection | side effects            |
 *   |--------------------------------|------------------------------|-------------|-------------------------|
 *   | createPiAgentFromWorkspace (dev)| yes                         | no          | creates `.fastagent/`   |
 *   | createPiAgentFromDefinition (L2)| no (you pass model object)  | yes         | none                    |
 *   | createPiAgentForEmbed (here)    | yes                         | **yes**     | **none**                |
 *
 * Why a separate opener and not a flag on the dev opener: the two differ on the K default and on
 * side effects, which is fundamental, not cosmetic. The dev opener defaults sessions to jsonl under
 * a `.fastagent/` directory it CREATES in the workspace (authoring continuity). Embedding into a
 * host app must not litter the host's project, so this opener creates nothing and leaves the K
 * defaults to the ladder (in-memory sessions, local exec env, in-process lease, pi auth) — you
 * inject your production session store / lease / env / auth instead.
 *
 * Tools note: like dev, the resolved toolset includes pi's default coding tools (read/bash/edit/
 * write) plus config.tools and discovered `tools/`. A production embed that should not expose shell/
 * filesystem tools must narrow them (config.tools with piReadOnlyTools, or an empty/app-specific
 * set) — a safety profile decision that lives in the workspace config, not in this opener.
 */
import type { Agent } from "../../agent.ts";
import type { FastagentConfig } from "./config.ts";
import { createPiAgentFromDefinition } from "./create.ts";
import type { LoadedDefinition } from "./definition.ts";
import type { AnyModel } from "./harness.ts";
import type { AuthResolver } from "./auth.ts";
import type { Lease } from "./invoke.ts";
import type { PiSessionStore } from "./sessions.ts";
import type { ToolCollision } from "./tool.ts";
import { resolveWorkspace } from "./workspace.ts";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";

export interface CreatePiAgentForEmbedOptions {
  /** Model spec override (e.g. "openai-codex/gpt-5.5"). Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
  // ── K: where/how it runs — inject your production infrastructure ─────────
  /** Session persistence. Default (unset): in-memory (no side effects); inject your durable store. */
  sessions?: PiSessionStore;
  /** Tool execution environment. Default (unset): local NodeExecutionEnv(cwd: dir); inject a sandbox. */
  env?: ExecutionEnv;
  /** Single-writer lease. Default (unset): in-process fail-fast; inject a distributed lease for multi-instance. */
  lease?: Lease;
  /** Auth resolution. Default (unset): pi OAuth then env vars; inject your secret/key resolver. */
  getApiKeyAndHeaders?: AuthResolver;
}

/**
 * "Point at a workspace folder → embeddable agent": reads the workspace config (model + tools), then
 * builds the agent with your injected K ports (anything left unset falls back to the ladder default).
 * Creates no files. Returns the assembled agent plus what was resolved, so the host can surface
 * diagnostics/collisions. Throws a clear error when no model source is set.
 */
export async function createPiAgentForEmbed(
  dir: string,
  options: CreatePiAgentForEmbedOptions = {},
): Promise<{
  agent: Agent;
  definition: LoadedDefinition;
  config: FastagentConfig;
  configPath?: string;
  modelSpec: string;
  model: AnyModel;
  toolNames: string[];
  toolCollisions: ToolCollision[];
}> {
  const { config, configPath, modelSpec, model, tools, toolNames, toolCollisions } = await resolveWorkspace(dir, {
    model: options.model,
  });
  const { agent, definition } = await createPiAgentFromDefinition(dir, {
    model,
    tools,
    // K: pass through; undefined → the ladder's default (in-memory / local env / in-process lease /
    // pi auth). Unlike dev, nothing is materialized on disk.
    sessions: options.sessions,
    env: options.env,
    lease: options.lease,
    getApiKeyAndHeaders: options.getApiKeyAndHeaders,
  });
  return { agent, definition, config, configPath, modelSpec, model, toolNames, toolCollisions };
}
