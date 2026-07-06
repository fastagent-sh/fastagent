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
  /**
   * Final assembled prompt, or a SYNC factory re-evaluated per invoke (how L1 serves dynamic
   * `instructions` + the skills listing). Distinct from {@link live}, which is the directory rung's
   * ASYNC re-read of prompt AND skills as one pair — both are exercised, by different rungs.
   */
  systemPrompt?: string | (() => string);
  /** Skills visible to the model / explicitly invokable (injected as harness resources). */
  skills?: Skill[];
  /**
   * Per-invoke source for the prompt+skills PAIR, re-evaluated on every harness build. When set it
   * supersedes {@link systemPrompt}/{@link skills} — one call yields both, so the skills listing
   * inside the prompt and the mounted skill resources can never come from two different reads. The
   * directory rung (L2) uses it to re-read the definition, so AGENTS.md/skills edits — the author's or
   * the agent's own — take effect on the next turn without a process restart. A rejection surfaces
   * as that invoke's `failed` event (the factory throw path), never a crash.
   */
  live?: () => Promise<{ systemPrompt?: string; skills?: Skill[] }>;
}

/**
 * Provider request retries. The OpenAI-family / Anthropic / Azure / Codex pi-ai adapters
 * implement client-side retries (429/5xx/request-phase network failures with backoff, honoring
 * Retry-After; a Codex websocket that fails before the stream starts falls back to SSE) but all
 * default maxRetries to 0 (even SDK-backed ones override the SDK default), so a single transient
 * `fetch failed` would otherwise kill the whole turn; 2 matches the OpenAI/Anthropic SDK default.
 * The google / vertex / bedrock / mistral adapters ignore this option (a pi-ai upstream gap) —
 * transients there still fail the turn. Mid-stream drops are deliberately NOT retried anywhere on
 * this path — partial output was already streamed and the SPEC event stream cannot retract it,
 * so a mid-stream failure surfaces as a `failed` event.
 */
const PROVIDER_MAX_RETRIES = 2;

/** Open-or-create the session per invoke: existing → open (history via buildContext); missing → create. */
export function piHarnessFactory(options: PiHarnessFactoryOptions): PiHarnessFactory {
  return async (sessionId) => {
    const session = await options.sessions.openOrCreate(sessionId);
    const fresh = options.live ? await options.live() : undefined;
    const { systemPrompt } = options;
    const prompt = fresh ? fresh.systemPrompt : typeof systemPrompt === "function" ? systemPrompt() : systemPrompt;
    const skills = fresh ? fresh.skills : options.skills;
    return new AgentHarness({
      env: options.env,
      session,
      models: options.models,
      model: options.model,
      tools: options.tools,
      systemPrompt: prompt,
      resources: skills ? { skills } : undefined,
      streamOptions: { maxRetries: PROVIDER_MAX_RETRIES },
    });
  };
}
