/**
 * Per-turn capabilities shared by every FastAgent-defined tool. A tool is built once and reused across
 * turns, so current cwd/session/activation bindings ride AsyncLocalStorage rather than definition
 * closures. Deploy-time ambients a tool closes over at build time do NOT belong here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** FastAgent's read-only port over the current conversation manager. Serving and chat adapt their
 * different concrete session implementations to this one tool-runtime contract. */
export interface ReadonlySessionManager {
  getSessionId(): string;
  getHeader(): Promise<{ id: string; timestamp: string }>;
  getBranch(): Promise<PiSessionEntry[]>;
}

/**
 * pi's AgentSession as the port above — the SAME adapter for both of its consumers: chat's resident
 * session (session-builder.ts) and serving's per-invoke one (agent-session-factory.ts).
 *
 * `sessionId` is the CALLER's, not pi's. A tool correlates its own state by the id the channel
 * minted; pi's is that id encoded into a filename-safe record name, and leaking the encoding here
 * would hand a telegram tool `s-1001234567890` for a room it knows as `-1001234567890`.
 */
export function agentSessionManager(session: AgentSession, sessionId: string): ReadonlySessionManager {
  return {
    getSessionId: () => sessionId,
    async getHeader() {
      const header = session.sessionManager.getHeader();
      if (!header) throw new Error("session has no metadata header");
      return { id: sessionId, timestamp: header.timestamp };
    },
    async getBranch() {
      return session.sessionManager.getBranch() as PiSessionEntry[];
    },
  };
}

/**
 * The turn's tool-activation bridge — narrow closures over the CURRENT session (bound per turn), so
 * a loader tool can activate deferred tools mid-turn without tool.ts importing the engine. pi records
 * the change in the session (`active_tools_change`) and the per-invoke restore
 * (agent-session-factory.ts) carries it into later turns; defineTool's wrapper stamps the newly-activated names on
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
   *  served session; chat.ts bridges the resident one (chat emulates deferral — same loader, same
   *  semantics). Absent only outside any turn (a bare `fastagent tool` run). */
  tools?: ToolActivation;
}

export const turnContext = new AsyncLocalStorage<TurnContext>();

/** The additive-activation contract, in ONE place for both bridges (the served session,
 *  chat.ts over pi's AgentSession): dedupe → keep registered names only (pi's setters THROW on
 *  unknown) → exclude already-active → the names to actually add (empty = nothing to set). */
export function additiveActivation(registered: string[], current: string[], names: string[]): string[] {
  const known = new Set(registered);
  const active = new Set(current);
  return [...new Set(names)].filter((name) => known.has(name) && !active.has(name));
}
