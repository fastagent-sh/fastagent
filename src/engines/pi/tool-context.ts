/**
 * Per-turn capabilities shared by every FastAgent-defined tool. A tool is built once and reused across
 * turns, so current cwd/session/activation bindings ride AsyncLocalStorage rather than definition
 * closures. Deploy-time ambients a tool closes over at build time do NOT belong here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

/** FastAgent's read-only port over the current conversation manager. Serving and chat adapt their
 * different concrete session implementations to this one tool-runtime contract. */
export interface ReadonlySessionManager {
  getSessionId(): string;
  getHeader(): Promise<{ id: string; timestamp: string }>;
  getBranch(): Promise<SessionTreeEntry[]>;
}

/**
 * The turn's tool-activation bridge — narrow closures over the CURRENT harness (invoke.ts builds it
 * per turn), so a loader tool can activate deferred tools mid-turn without tool.ts importing the
 * harness. pi records the change in the session (`active_tools_change`) and the per-invoke restore
 * (harness.ts) carries it into later turns; defineTool's wrapper stamps the newly-activated names on
 * the tool result (`addedToolNames`) — the load point native deferred-loading providers preserve the
 * prompt-cache prefix with.
 */
export interface ToolActivation {
  /** Names of the currently ACTIVE tools. */
  active(): string[];
  /** Every registered tool (active or not) — the discovery corpus for a loader like `search_tools`. */
  registered(): Array<{ name: string; description: string }>;
  /** ADDITIVE activation. Unknown names are filtered out before reaching pi (whose `setActiveTools`
   *  THROWS on them); resolves the names actually newly activated (already-active names don't repeat). */
  activate(names: string[]): Promise<string[]>;
}

export interface TurnContext {
  /** Working directory for this execution. Falls back to process.cwd() only for an unbound direct call. */
  cwd?: string;
  /** Current conversation manager. Absent outside a FastAgent-managed agent turn. */
  sessionManager?: ReadonlySessionManager;
  /** Tool activation for the current turn. Two producers, one consumer surface: invoke.ts bridges the
   *  serving harness; chat.ts bridges pi's AgentSession (chat emulates deferral — same loader, same
   *  semantics). Absent only outside any turn (a bare `fastagent tool` run). */
  tools?: ToolActivation;
}

export const turnContext = new AsyncLocalStorage<TurnContext>();

/** The additive-activation contract, in ONE place for both bridges (invoke.ts over the harness,
 *  chat.ts over pi's AgentSession): dedupe → keep registered names only (pi's setters THROW on
 *  unknown) → exclude already-active → the names to actually add (empty = nothing to set). */
export function additiveActivation(registered: string[], current: string[], names: string[]): string[] {
  const known = new Set(registered);
  const active = new Set(current);
  return [...new Set(names)].filter((name) => known.has(name) && !active.has(name));
}
