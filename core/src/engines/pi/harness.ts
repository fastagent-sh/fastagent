/**
 * pi harness **wiring** — note: the harness itself (turn loop, tool execution,
 * context management) is pi's `AgentHarness`; this module only constructs one per
 * session. The agent definition (AGENTS.md + skills) is NOT part of the harness —
 * it is content fed INTO it (see definition.ts), the boundary the product rests on.
 *
 * pi continuity wiring: open-or-create delivers "same session, multi-turn memory".
 *
 * Under the stateless design the harness is discarded after each use; continuity
 * comes from **persisting the session (PiSessionStore) and re-opening it per invoke** — pi's
 * prompt() runs buildContext() (getPathToRoot + buildSessionContext), folding the
 * historical entries back into context. This is SPEC portable conformance
 * (no location dependence) made concrete.
 */
import { AgentHarness } from "@earendil-works/pi-agent-core";
import type { AgentTool, ExecutionEnv, Skill } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { type AuthResolver, resolvePiAuth } from "./auth.ts";
import type { PiSessionStore } from "./sessions.ts";

/**
 * pi's Model with the API-shape generic erased — fastagent only passes models
 * through to the harness, so the generic carries no information. One alias keeps
 * the `any` auditable (tighten here if pi exports a variance-friendly type).
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional variance-friendly model type, audited at this single point (see above)
export type AnyModel = Model<any>;

/**
 * Builds a pi harness bound to the given session — called once per invoke.
 * env/model/tools are injected inside the factory (the closure is the wiring).
 * Constructed by {@link piHarnessFactory}; hand-rolled in tests/custom wiring.
 */
export type PiHarnessFactory = (session: string) => AgentHarness | Promise<AgentHarness>;

export interface PiHarnessFactoryOptions {
  /** Session persistence (see sessions.ts). Continuity = same backing store + same session id. */
  sessions: PiSessionStore;
  env: ExecutionEnv;
  model: AnyModel;
  tools?: AgentTool[];
  /**
   * Final assembled prompt, or a factory **re-evaluated per invoke** (a fresh harness
   * is built per turn) so time-sensitive segments (e.g. current date) stay current.
   */
  systemPrompt?: string | (() => string);
  /** Skills visible to the model / explicitly invokable (injected as harness resources). */
  skills?: Skill[];
  /** Model auth resolution. Defaults to {@link resolvePiAuth}: pi OAuth (~/.pi/agent/auth.json) first, then env vars. */
  getApiKeyAndHeaders?: AuthResolver;
}

/**
 * The continuity-capable PiHarnessFactory: open-or-create the session per invoke.
 * Existing → open (the harness sees history via buildContext); missing → create.
 */
export function piHarnessFactory(options: PiHarnessFactoryOptions): PiHarnessFactory {
  return async (sessionId) => {
    const session = await options.sessions.openOrCreate(sessionId);
    const { systemPrompt } = options;
    return new AgentHarness({
      env: options.env,
      session,
      model: options.model,
      tools: options.tools,
      systemPrompt: typeof systemPrompt === "function" ? systemPrompt() : systemPrompt,
      resources: options.skills ? { skills: options.skills } : undefined,
      getApiKeyAndHeaders: options.getApiKeyAndHeaders ?? resolvePiAuth(),
    });
  };
}
