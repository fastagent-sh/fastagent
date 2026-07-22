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
 * The session custom-entry type recording ONE activation delta: `{ names }` — exactly the deferred
 * tools a loader activated in that call. The DEDICATED record the resolve below reads: pi's own
 * `active_tools_change` entries are full active-set SNAPSHOTS (setActiveTools persists everything
 * active at that moment), and reinterpreting a snapshot as activations would keep a tool active in
 * old sessions after the author flips it to `deferred` — the session never discovered it. Deltas
 * carry only what was actually discovered.
 */
export const TOOL_ACTIVATION_ENTRY = "fastagent:tool-activation";

/** The session a factory-built harness is bound to — the seam the activation bridge (invoke.ts) uses
 *  to write {@link TOOL_ACTIVATION_ENTRY} deltas (pi's harness keeps its session private). Absent for
 *  a harness built outside {@link piHarnessFactory}: activation still works in-turn there, but is not
 *  recorded — the factory owns persistence. */
const harnessSessions = new WeakMap<AgentHarness, PiSession>();
export type PiSession = Awaited<ReturnType<PiSessionStore["openOrCreate"]>>;
export function harnessSession(harness: AgentHarness): PiSession | undefined {
  return harnessSessions.get(harness);
}

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
 * Retry policy for generated compaction/branch-summary model calls (pi ≥0.81.1, #6901). OPT-IN
 * upstream — an undefined policy means no retries — so both compaction paths pass it explicitly:
 * the harness config (auto-compaction inside a run) and the manual `compact()` dispatch in
 * session-control. Values mirror pi's own app defaults (maxRetries 3, base 2s exponential).
 */
export const SUMMARIZATION_RETRY_POLICY = { enabled: true, maxRetries: 3, baseDelayMs: 2000 } as const;

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
 * A record is NOT replayed as a frozen snapshot — the active set is rebuilt as the UNION of the
 * initial set and the recorded names (filtered to the mounted tools: the constructor THROWS on
 * unknown names, so a recorded-but-removed tool would otherwise brick every future invoke of that
 * session). On the serving path only the additive activation bridge writes records, so a record's
 * real semantic is "which deferred tools this session activated" — layered on top of whatever the
 * workspace mounts TODAY. A snapshot replay would silently freeze a later-added non-deferred tool
 * out of every session the loader ever touched. Missing recorded names are logged (fail visibly) —
 * ONCE per session+missing set: a fresh harness is built per invoke and channel sessions live for
 * weeks, so an un-deduped warn would repeat every turn and dilute its own signal. A log-dedup memo
 * (like L2's findings memo), not session state — the resolve stays derived from the session.
 */
const warnedRestores = new Set<string>();

/** pi's ThinkingLevel scale as a checkable set — THE single source for fastagent (session entries
 *  store plain strings; session-control's dispatch validation and capabilities derive from this).
 *  The `satisfies Record<ThinkingLevel, …>` anchor makes it EXHAUSTIVE against pi's union: pi
 *  adding a level turns this into a type error instead of a silent drift where `set_thinking`
 *  rejects a value pi supports. */
const ALL_THINKING_LEVELS = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} satisfies Record<ThinkingLevel, true>;
export const THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set(Object.keys(ALL_THINKING_LEVELS) as ThinkingLevel[]);

/** The shape both override consumers walk — a session entry, structurally. */
export interface OverrideEntryLike {
  type: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/**
 * The session's durable override FACTS — the ONE walk both surfaces consume (`state()` reports the
 * recorded truth; `resolveHarnessOverrides` below applies registry/scale fallbacks on top). The
 * LAST entry of each kind wins, and a malformed record reads as ABSENT for that kind — never
 * skipped over to an earlier record: the reporting surface and the execution surface must agree on
 * which record is "the" override.
 */
export function lastOverrideEntries(entries: OverrideEntryLike[]): {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
} {
  let model: { provider: string; modelId: string } | undefined;
  let modelSeen = false;
  let thinkingLevel: string | undefined;
  let thinkingSeen = false;
  for (let i = entries.length - 1; i >= 0 && !(modelSeen && thinkingSeen); i--) {
    const e = entries[i];
    if (!modelSeen && e?.type === "model_change") {
      modelSeen = true;
      if (e.provider !== undefined && e.modelId !== undefined) model = { provider: e.provider, modelId: e.modelId };
    }
    if (!thinkingSeen && e?.type === "thinking_level_change") {
      thinkingSeen = true;
      if (e.thinkingLevel !== undefined) thinkingLevel = e.thinkingLevel;
    }
  }
  return { model, thinkingLevel };
}

/**
 * Resolve the session's model/thinking OVERRIDES for a fresh harness — same shape as the
 * active-tools resolve above: pi writes `model_change`/`thinking_level_change` entries on explicit
 * setModel/setThinkingLevel (the control plane's `set_model`/`set_thinking` append them directly)
 * but a fresh harness never reads them back. Override facts come from {@link lastOverrideEntries};
 * this adds the EXECUTION fallbacks: a recorded model no longer in this deployment's registry falls
 * back to the default with a deduped warn (fail visibly without bricking the session — the
 * conversation must survive a registry change across deploys); an unknown thinking level likewise.
 */
export function resolveHarnessOverrides(
  entries: OverrideEntryLike[],
  models: Models,
  defaults: { model: AnyModel; thinkingLevel: ThinkingLevel },
  sessionId: string,
): { model: AnyModel; thinkingLevel: ThinkingLevel } {
  let model = defaults.model;
  let thinkingLevel = defaults.thinkingLevel;
  const warnOnce = (key: string, message: string) => {
    const emit = warnedRestores.has(key) ? log.debug : log.warn;
    warnedRestores.add(key);
    emit(message);
  };
  const recorded = lastOverrideEntries(entries);
  if (recorded.model) {
    const found = models.getModel(recorded.model.provider, recorded.model.modelId);
    if (found) model = found as AnyModel;
    else {
      warnOnce(
        `${sessionId}\u0000model\u0000${recorded.model.provider}/${recorded.model.modelId}`,
        `[fastagent] session ${sessionId}: recorded model override ${recorded.model.provider}/${recorded.model.modelId} is not in this deployment's registry — using the configured default`,
      );
    }
  }
  if (recorded.thinkingLevel !== undefined) {
    if (THINKING_LEVELS.has(recorded.thinkingLevel as ThinkingLevel)) {
      thinkingLevel = recorded.thinkingLevel as ThinkingLevel;
    } else {
      warnOnce(
        `${sessionId}\u0000thinking\u0000${recorded.thinkingLevel}`,
        `[fastagent] session ${sessionId}: recorded thinking level "${recorded.thinkingLevel}" is unknown — using the configured default`,
      );
    }
  }
  return { model, thinkingLevel };
}
export function resolveHarnessActiveToolNames(
  recorded: string[] | null,
  tools: AgentTool[],
  sessionId: string,
): string[] | undefined {
  const anyDeferred = tools.some(isDeferredTool);
  const initial = tools.filter((t) => !isDeferredTool(t)).map((t) => t.name);
  if (recorded === null) return anyDeferred ? initial : undefined;
  const mounted = new Set(tools.map((t) => t.name));
  const known = recorded.filter((name) => mounted.has(name));
  const missing = recorded.filter((name) => !mounted.has(name));
  if (missing.length > 0) {
    const emit = warnedRestores.has(`${sessionId}\u0000${missing.join(",")}`) ? log.debug : log.warn;
    warnedRestores.add(`${sessionId}\u0000${missing.join(",")}`);
    emit(`[fastagent] session ${sessionId}: dropping recorded activation(s) no longer mounted: ${missing.join(", ")}`);
  }
  return [...new Set([...initial, ...known])];
}

/** Open-or-create the session per invoke: existing → open (history via buildContext); missing → create. */
export function piHarnessFactory(options: PiHarnessFactoryOptions): PiHarnessFactory {
  return async (sessionId) => {
    const session = await options.sessions.openOrCreate(sessionId);
    // One extra entry walk per invoke to collect the activation deltas — negligible against the model
    // call, same trade as L2's per-invoke definition re-read. Serving sessions never branch, so a flat
    // getEntries() read (no leaf-path walk) is correct.
    const entries = await session.getEntries();
    const activated = entries.flatMap((e) =>
      e.type === "custom" && e.customType === TOOL_ACTIVATION_ENTRY
        ? ((e.data as { names?: string[] } | undefined)?.names ?? [])
        : [],
    );
    const fresh = options.live ? await options.live() : undefined;
    const { systemPrompt } = options;
    const prompt = fresh ? fresh.systemPrompt : typeof systemPrompt === "function" ? systemPrompt() : systemPrompt;
    const skills = fresh ? fresh.skills : options.skills;
    // Session overrides (set_model / set_thinking) win over the assembly defaults — same entry walk.
    const overrides = resolveHarnessOverrides(
      entries as Parameters<typeof resolveHarnessOverrides>[0],
      options.models,
      { model: options.model, thinkingLevel: options.thinkingLevel ?? DEFAULT_THINKING_LEVEL },
      sessionId,
    );
    const harness = new AgentHarness({
      env: options.env,
      session,
      models: options.models,
      model: overrides.model,
      thinkingLevel: overrides.thinkingLevel,
      tools: options.tools,
      activeToolNames: resolveHarnessActiveToolNames(
        activated.length > 0 ? activated : null,
        options.tools ?? [],
        sessionId,
      ),
      systemPrompt: prompt,
      resources: skills ? { skills } : undefined,
      streamOptions: { maxRetries: PROVIDER_MAX_RETRIES },
      retry: SUMMARIZATION_RETRY_POLICY,
    });
    harnessSessions.set(harness, session);
    return harness;
  };
}
