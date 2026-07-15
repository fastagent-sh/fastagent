/**
 * pi harness wiring: construct one pi `AgentHarness` per session. The agent definition (AGENTS.md +
 * skills) is content fed INTO the harness (see definition.ts), not part of it.
 *
 * Under the stateless design the harness is discarded after each use; continuity comes from
 * persisting the session (PiSessionStore) and re-opening it per invoke — pi's prompt() folds the
 * historical entries back into context via buildContext().
 */
import { AgentHarness } from "@earendil-works/pi-agent-core";
import type { AgentTool, ExecutionEnv, Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import { log } from "../../log.ts";
import type { PiSessionStore } from "./sessions.ts";
import { isDeferredTool } from "./tool.ts";

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
  /** Reasoning effort for the model (pi's scale). Unset = fastagent's pinned default ("medium", pi
   *  TUI parity — see {@link DEFAULT_THINKING_LEVEL}); unsupported levels are clamped by pi per model. */
  thinkingLevel?: ThinkingLevel;
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

/**
 * The serving default for reasoning effort, pinned to what pi's TUI defaults to (its
 * DEFAULT_THINKING_LEVEL) — NOT inherited from the bare harness, whose own fallback is "off": an
 * author vibes at "medium" in pi and must get "medium" when served (fidelity), and pinning the value
 * here means an upstream default change in either place cannot silently alter deployments. Models
 * that don't support a level are clamped by pi per model.
 */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * Resolve the active-tool set for a fresh harness — the ONE place both fallbacks live. pi's harness
 * WRITES active-tool changes to the session (`setActiveTools` → `active_tools_change`) but its
 * constructor never reads them back — pi's long-lived TUI harness keeps the set in memory, while
 * fastagent builds a FRESH harness per invoke, which would silently reset the session's active set
 * every turn.
 *
 * No record (`null`) → the INITIAL set: every non-deferred tool; undefined when nothing is deferred
 * (pi's default — all active — applies, and no session entry is ever written; tool-sets without
 * deferral behave exactly as before deferral existed).
 *
 * A recorded set is filtered to the currently-mounted tools: the constructor THROWS on unknown names,
 * so a recorded tool that was since removed from the workspace would otherwise brick every future
 * invoke of that session. An intact EMPTY set is restored as-is (pi allows `setActiveTools([])`; a
 * deliberate recorded state, not a degradation). Only a NON-empty set that filters down to empty
 * falls back to the initial set — the recorded intent cannot be honored, and honoring its empty
 * shadow would be a silent capability loss. Both filter degradations are logged (fail visibly) —
 * ONCE per session+missing set: a fresh harness is built per invoke and channel sessions live for
 * weeks, so an un-deduped warn would repeat every turn and dilute its own signal. A log-dedup memo
 * (like L2's findings memo), not session state — the resolve stays derived from the session.
 */
const warnedRestores = new Set<string>();
export function resolveHarnessActiveToolNames(
  recorded: string[] | null,
  tools: AgentTool[],
  sessionId: string,
): string[] | undefined {
  const initial = tools.some(isDeferredTool) ? tools.filter((t) => !isDeferredTool(t)).map((t) => t.name) : undefined;
  if (recorded === null) return initial;
  const mounted = new Set(tools.map((t) => t.name));
  const known = recorded.filter((name) => mounted.has(name));
  if (known.length === recorded.length) return known; // intact, including a deliberate []
  const missing = recorded.filter((name) => !mounted.has(name));
  const emit = warnedRestores.has(`${sessionId}\u0000${missing.join(",")}`) ? log.debug : log.warn;
  warnedRestores.add(`${sessionId}\u0000${missing.join(",")}`);
  if (known.length === 0) {
    emit(
      `[fastagent] session ${sessionId}: none of its recorded active tools (${missing.join(", ")}) are mounted — falling back to the initial active set (every non-deferred tool)`,
    );
    return initial;
  }
  emit(`[fastagent] session ${sessionId}: dropping recorded active tool(s) no longer mounted: ${missing.join(", ")}`);
  return known;
}

/** Open-or-create the session per invoke: existing → open (history via buildContext); missing → create. */
export function piHarnessFactory(options: PiHarnessFactoryOptions): PiHarnessFactory {
  return async (sessionId) => {
    const session = await options.sessions.openOrCreate(sessionId);
    // One extra entry walk per invoke to read the recorded active-tool set (buildContext is the only
    // accessor) — negligible against the model call, same trade as L2's per-invoke definition re-read.
    const context = await session.buildContext();
    const fresh = options.live ? await options.live() : undefined;
    const { systemPrompt } = options;
    const prompt = fresh ? fresh.systemPrompt : typeof systemPrompt === "function" ? systemPrompt() : systemPrompt;
    const skills = fresh ? fresh.skills : options.skills;
    return new AgentHarness({
      env: options.env,
      session,
      models: options.models,
      model: options.model,
      thinkingLevel: options.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      tools: options.tools,
      activeToolNames: resolveHarnessActiveToolNames(context.activeToolNames, options.tools ?? [], sessionId),
      systemPrompt: prompt,
      resources: skills ? { skills } : undefined,
      streamOptions: { maxRetries: PROVIDER_MAX_RETRIES },
    });
  };
}
