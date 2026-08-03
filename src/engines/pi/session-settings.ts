/**
 * What a session is SET TO, and what it may be set to. Model and thinking level are ONE setting —
 * which levels exist is a property of the model — so they resolve together, here, and `state()`, the
 * `set_thinking` gate and the fresh-harness resolve all read this rather than deriving their own.
 *
 * Read-only by design. The durable record may hold a level the current model cannot do; that record
 * is the user's PREFERENCE, so resolving per read restores it when the session returns to a capable
 * model. (It could not be made unrepresentable anyway: `model_change`/`thinking_level_change` are
 * pi's entries, and pi appends them itself.)
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Models, clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AnyModel } from "./harness.ts";

/** Which strings are levels at all — the vocabulary. What a MODEL supports is
 *  `getSupportedThinkingLevels`. The `satisfies` anchor keeps this exhaustive against pi's union: a
 *  level pi adds becomes a type error here rather than a value `set_thinking` silently rejects. */
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

/** The last entry of each kind wins, and a malformed one reads as ABSENT rather than falling through
 *  to an earlier record — which record is "the" override must not depend on who is asking. */
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

export interface SessionSettings {
  model: AnyModel;
  /** Already clamped to what {@link model} supports. */
  thinkingLevel: ThinkingLevel;
  /** What `set_thinking` accepts for this session. */
  availableThinkingLevels: string[];
  /** Recorded but not honored — only the execution path reports it (as a warn). */
  dropped?: { model?: string; thinkingLevel?: { recorded: string; running: string; known: boolean } };
}

/** `defaults` is the assembly's configured pair — what a session with no overrides runs on. */
export function resolveSessionSettings(
  entries: OverrideEntryLike[],
  models: Models,
  defaults: { model: AnyModel; thinkingLevel: ThinkingLevel },
): SessionSettings {
  const recorded = lastOverrideEntries(entries);
  const dropped: NonNullable<SessionSettings["dropped"]> = {};

  // A registry change across deploys must not brick the conversation.
  let model = defaults.model;
  if (recorded.model) {
    const found = models.getModel(recorded.model.provider, recorded.model.modelId);
    if (found) model = found as AnyModel;
    else dropped.model = `${recorded.model.provider}/${recorded.model.modelId}`;
  }

  const availableThinkingLevels = getSupportedThinkingLevels(model) as string[];
  let thinkingLevel = defaults.thinkingLevel;
  if (recorded.thinkingLevel !== undefined) {
    const level = recorded.thinkingLevel;
    if (!THINKING_LEVELS.has(level as ThinkingLevel)) {
      dropped.thinkingLevel = { recorded: level, running: thinkingLevel, known: false };
    } else {
      // pi's clamp takes the lowest supported level AT OR ABOVE the recorded one, falling back
      // downward only when nothing is above: a gap resolves UPWARD and costs more, not less. Which is
      // why `dropped` names both levels rather than reporting a substitution.
      thinkingLevel = clampThinkingLevel(model, level as ThinkingLevel) as ThinkingLevel;
      if (thinkingLevel !== level) {
        dropped.thinkingLevel = { recorded: level, running: thinkingLevel, known: true };
      }
    }
  }
  return {
    model,
    thinkingLevel,
    availableThinkingLevels,
    ...(dropped.model || dropped.thinkingLevel ? { dropped } : {}),
  };
}
