/**
 * pi harness **wiring** — note: the harness itself (turn loop, tool execution,
 * context management) is pi's `AgentHarness`; this module only constructs one per
 * session. The agent definition (AGENTS.md + skills) is NOT part of the harness —
 * it is content fed INTO it (see definition.ts), the boundary the product rests on.
 *
 * pi continuity wiring: open-or-create delivers "same session, multi-turn memory".
 *
 * Under the stateless design the harness is discarded after each use; continuity
 * comes from **persisting the session (repo) and re-opening it per invoke** — pi's
 * prompt() runs buildContext() (getPathToRoot + buildSessionContext), folding the
 * historical entries back into context. This is SPEC portable conformance
 * (no location dependence) made concrete.
 */
import { AgentHarness } from "@earendil-works/pi-agent-core";
import type {
  AgentTool,
  ExecutionEnv,
  Session,
  SessionMetadata,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { type AuthResolver, resolvePiAuth } from "./auth.ts";

/** Build a pi harness bound to the given session. env/model/tools are injected inside the factory. */
export type BuildHarness = (session: string) => AgentHarness | Promise<AgentHarness>;

/**
 * Minimal repo shape needed for open-or-create (structurally satisfied by InMemorySessionRepo).
 *
 * KNOWN DEBT: this is a single-sample abstraction. pi's JsonlSessionRepo does NOT fit
 * (its create() requires { cwd }). The hosting/K knife will reshape this interface when
 * the first persistent backend lands; do not generalize it before then.
 */
export interface SessionRepoLike {
  list(): Promise<SessionMetadata[]>;
  open(metadata: SessionMetadata): Promise<Session>;
  create(options: { id?: string }): Promise<Session>;
}

export interface PiHarnessConfig {
  /** Session persistence backend; continuity requires **reusing the same instance across invokes**. */
  repo: SessionRepoLike;
  env: ExecutionEnv;
  model: Model<any>;
  tools?: AgentTool[];
  systemPrompt?: string;
  /** Skills visible to the model / explicitly invokable (injected as harness resources). */
  skills?: Skill[];
  /** Model auth resolution. Defaults to {@link resolvePiAuth}: pi OAuth (~/.pi/agent/auth.json) first, then env vars. */
  getApiKeyAndHeaders?: AuthResolver;
}

/**
 * Build a continuity-capable BuildHarness: open-or-create the session per invoke.
 * Existing → open (the harness sees history via buildContext); missing → create.
 */
export function piHarnessFactory(config: PiHarnessConfig): BuildHarness {
  return async (sessionId) => {
    const session = await openOrCreate(config.repo, sessionId);
    return new AgentHarness({
      env: config.env,
      session,
      model: config.model,
      tools: config.tools,
      systemPrompt: config.systemPrompt,
      resources: config.skills ? { skills: config.skills } : undefined,
      getApiKeyAndHeaders: config.getApiKeyAndHeaders ?? resolvePiAuth(),
    });
  };
}

async function openOrCreate(repo: SessionRepoLike, sessionId: string): Promise<Session> {
  const existing = (await repo.list()).find((m) => m.id === sessionId);
  return existing ? repo.open(existing) : repo.create({ id: sessionId });
}
