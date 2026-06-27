/**
 * pi harness wiring: construct one pi `AgentHarness` per session. The agent definition (AGENTS.md +
 * skills) is content fed INTO the harness (see definition.ts), not part of it.
 *
 * Under the stateless design the harness is discarded after each use; continuity comes from
 * persisting the session (PiSessionStore) and re-opening it per invoke — pi's prompt() folds the
 * historical entries back into context via buildContext().
 */
import { AgentHarness } from "@earendil-works/pi-agent-core";
import type { AgentTool, ExecutionEnv, Skill } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { PiSessionStore } from "./sessions.ts";

/**
 * pi's Model with the API-shape generic erased — fastagent only passes models through to the
 * harness, so the generic carries no information. One alias keeps the `any` auditable.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional variance-friendly model type, audited at this single point
export type AnyModel = Model<any>;

/** Builds a pi harness bound to the given session — called once per invoke. */
export type PiHarnessFactory = (session: string) => AgentHarness | Promise<AgentHarness>;

export interface PiHarnessFactoryOptions {
  /** Session persistence. Continuity = same backing store + same session id. */
  sessions: PiSessionStore;
  env: ExecutionEnv;
  /** Provider collection for all model requests; {@link model} must belong to it (same provider id). */
  models: Models;
  model: AnyModel;
  tools?: AgentTool[];
  /** Final assembled prompt, or a factory re-evaluated per invoke so time-sensitive segments stay current. */
  systemPrompt?: string | (() => string);
  /** Skills visible to the model / explicitly invokable (injected as harness resources). */
  skills?: Skill[];
}

/** Open-or-create the session per invoke: existing → open (history via buildContext); missing → create. */
export function piHarnessFactory(options: PiHarnessFactoryOptions): PiHarnessFactory {
  return async (sessionId) => {
    const session = await options.sessions.openOrCreate(sessionId);
    const { systemPrompt } = options;
    return new AgentHarness({
      env: options.env,
      session,
      models: options.models,
      model: options.model,
      tools: options.tools,
      systemPrompt: typeof systemPrompt === "function" ? systemPrompt() : systemPrompt,
      resources: options.skills ? { skills: options.skills } : undefined,
    });
  };
}
