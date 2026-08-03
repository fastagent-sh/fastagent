/**
 * pi harness wiring: construct one pi `AgentHarness` per session. The agent definition (AGENTS.md +
 * skills) is content fed INTO the harness (see definition.ts), not part of it.
 *
 * Under the stateless design the harness is discarded after each use; continuity comes from
 * persisting the session (PiSessionStore) and re-opening it per invoke — pi's prompt() folds the
 * historical entries back into context via buildContext().
 */
import { AgentHarness } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv, ExecutionToolContext, Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import { log } from "../../log.ts";
import type { PiSessionStore } from "./sessions.ts";
import { isDeferredTool, type MountedTool } from "./tool.ts";
import { type OverrideEntryLike, resolveSessionSettings } from "./session-settings.ts";

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
// Keyed by IDENTITY, and deliberately context-AGNOSTIC: which session an instance is bound to has
// nothing to do with the harness's tool-context parameter (pi 0.83), and naming a concrete one would
// force every caller's harness type to match this map's. `any` is the context, not the argument — it
// still has to BE a harness.
// biome-ignore lint/suspicious/noExplicitAny: context-agnostic by intent, audited at this single point
type AnyHarness = AgentHarness<any>;
const harnessSessions = new WeakMap<AnyHarness, PiSession>();
export type PiSession = Awaited<ReturnType<PiSessionStore["openOrCreate"]>>;
export function harnessSession(harness: AnyHarness): PiSession | undefined {
  return harnessSessions.get(harness);
}

/**
 * pi's Model with the API-shape generic erased — fastagent only passes models through to the
 * harness, so the generic carries no information. One alias keeps the `any` auditable.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional variance-friendly model type, audited at this single point
export type AnyModel = Model<any>;

/** Builds a pi harness bound to the given session — called once per invoke. */
/** The harness fastagent builds: context-typed on {@link ExecutionToolContext}, because that is what
 *  pi's env-backed default tools read (pi 0.83). Custom tools are context-FREE and stay assignable — a
 *  four-parameter `execute` satisfies the five-parameter one, so `defineTool` is untouched by this. */
type PiHarness = AgentHarness<ExecutionToolContext>;
export type PiHarnessFactory = (session: string) => PiHarness | Promise<PiHarness>;

export interface PiHarnessFactoryOptions {
  /** Session persistence. Continuity = same backing store + same session id. */
  sessions: PiSessionStore;
  /** Filesystem/process environment for the default coding tools. Handed to the harness as the TURN's
   *  tool context (pi 0.83), which is how read/bash/edit/write reach the machine at all — so this is the
   *  ONE seam a sandbox adapter implements, not a knob beside the tools that ignore it. */
  env: ExecutionEnv;
  /** Provider collection for all model requests; {@link model} must belong to it (same provider id). */
  models: Models;
  model: AnyModel;
  /** Reasoning effort for the model (pi's scale). Unset = fastagent's pinned default ("medium", pi
   *  TUI parity — see {@link DEFAULT_THINKING_LEVEL}); unsupported levels are clamped by pi per model. */
  thinkingLevel?: ThinkingLevel;
  tools?: MountedTool[];
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
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

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

/**
 * {@link resolveSessionSettings} plus the warn only the execution path owes: a recorded pair can stop
 * being executable with no control-plane command involved (pi appends these entries itself; a
 * deployment's configured model can change between restarts). Deduped per session+cause — it would
 * otherwise repeat every turn.
 */
export function resolveHarnessOverrides(
  entries: OverrideEntryLike[],
  models: Models,
  defaults: { model: AnyModel; thinkingLevel: ThinkingLevel },
  sessionId: string,
): { model: AnyModel; thinkingLevel: ThinkingLevel } {
  const settings = resolveSessionSettings(entries, models, defaults);
  const warnOnce = (key: string, message: string) => {
    const emit = warnedRestores.has(key) ? log.debug : log.warn;
    warnedRestores.add(key);
    emit(message);
  };
  const dropped = settings.dropped;
  if (dropped?.model) {
    warnOnce(
      `${sessionId}\u0000model\u0000${dropped.model}`,
      `[fastagent] session ${sessionId}: recorded model override ${dropped.model} is not in this deployment's registry — using the configured default`,
    );
  }
  if (dropped?.thinkingLevel) {
    const { recorded, running, known } = dropped.thinkingLevel;
    warnOnce(
      `${sessionId}\u0000thinking\u0000${settings.model.provider}/${settings.model.id}\u0000${recorded}`,
      known
        ? `[fastagent] session ${sessionId}: recorded thinking level "${recorded}" is not supported by ${settings.model.provider}/${settings.model.id} — running at "${running}"`
        : `[fastagent] session ${sessionId}: recorded thinking level "${recorded}" is unknown — using the configured default`,
    );
  }
  return { model: settings.model, thinkingLevel: settings.thinkingLevel };
}

export function resolveHarnessActiveToolNames(
  recorded: string[] | null,
  tools: MountedTool[],
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
    const harness = new AgentHarness<ExecutionToolContext>({
      // Static, not a per-turn provider: the env is fixed for the agent's lifetime, and resolving a
      // constant per turn would only add a promise to the turn's critical path.
      toolContext: { env: options.env },
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
