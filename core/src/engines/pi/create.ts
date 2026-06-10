/**
 * createPiAgent — start a pi agent in one call, batteries-included.
 *
 * Collapses "createAgent + piHarnessFactory + default repo/env/auth/lease" into a
 * single call so app code never assembles pi's InMemorySessionRepo / NodeExecutionEnv
 * by hand. Every default is overridable: production injects a jsonl/pg/ddb repo,
 * a sandbox/e2b env, etc.
 */
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentTool, ExecutionEnv, Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import type { Agent } from "../../agent.ts";
import type { AuthResolver } from "./auth.ts";
import { type SessionRepoLike, piHarnessFactory } from "./harness.ts";
import { createAgent } from "./index.ts";
import type { Lease } from "./lease.ts";

export interface CreatePiAgentOptions {
  model: Model<any>;
  systemPrompt?: string;
  tools?: AgentTool[];
  /** Skills visible to the model / explicitly invokable (driver output; injected as harness resources). */
  skills?: Skill[];
  /** Session persistence. Defaults to in-process InMemorySessionRepo (dev); production injects jsonl/pg/ddb. */
  repo?: SessionRepoLike;
  /** Tool execution environment. Defaults to local NodeExecutionEnv (cwd); production injects sandbox/e2b. */
  env?: ExecutionEnv;
  /** Auth resolution. Defaults to resolvePiAuth() (pi OAuth first, then env vars). */
  getApiKeyAndHeaders?: AuthResolver;
  /** Single-writer lease. Defaults to in-process fail-fast inProcessLease(). */
  lease?: Lease;
}

export function createPiAgent(options: CreatePiAgentOptions): Agent {
  return createAgent({
    lease: options.lease,
    buildHarness: piHarnessFactory({
      repo: options.repo ?? new InMemorySessionRepo(),
      env: options.env ?? new NodeExecutionEnv({ cwd: process.cwd() }),
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      skills: options.skills,
      getApiKeyAndHeaders: options.getApiKeyAndHeaders,
    }),
  });
}
