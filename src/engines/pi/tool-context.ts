/** Per-turn capabilities shared by every FastAgent-defined tool. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionEntry as PiSessionEntry, AgentSession } from "@earendil-works/pi-coding-agent";

/** FastAgent's read-only port over the current conversation manager. */
export interface ReadonlySessionManager {
  getSessionId(): string;
  getHeader(): Promise<{ id: string; timestamp: string }>;
  getBranch(): Promise<PiSessionEntry[]>;
}

/** pi's AgentSession as the port above — the SAME adapter for both of its consumers. */
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
 * The turn's tool-activation bridge — narrow closures over the CURRENT session (bound per turn), so a loader tool can
 * activate deferred tools mid-turn without tool.ts importing the engine. pi records the change in the session
 * (`active_tools_change`) and the per-invoke restore (agent-session-factory.ts) carries it into later turns;
 * defineTool's wrapper stamps the newly-activated names on the tool result (`addedToolNames`) — the load point native
 * deferred-loading providers preserve the prompt-cache prefix with.
 */
export interface ToolActivation {
  /** Names of the currently ACTIVE tools. */
  active(): string[];
  /** Every registered tool (active or not) — the discovery corpus for a loader like `search_tools`. */
  registered(): Array<{ name: string; description: string }>;
  /** ADDITIVE activation. */
  activate(names: string[]): string[];
}

/** The activation bridge over a live pi session — the ONE implementation, for both consumers. */
export function sessionToolActivation(session: AgentSession, onActivated?: (added: string[]) => void): ToolActivation {
  return {
    active: () => session.getActiveToolNames(),
    registered: () => session.getAllTools().map((t) => ({ name: t.name, description: t.description ?? "" })),
    activate(names) {
      const current = session.getActiveToolNames();
      const added = additiveActivation(
        session.getAllTools().map((t) => t.name),
        current,
        names,
      );
      if (added.length === 0) return added;
      session.setActiveToolsByName([...current, ...added]);
      onActivated?.(added);
      return added;
    },
  };
}

export interface TurnContext {
  /** Working directory for this execution. */
  cwd?: string;
  sessionManager?: ReadonlySessionManager;
  tools?: ToolActivation;
}

export const turnContext = new AsyncLocalStorage<TurnContext>();

/**
 * dedupe → keep registered names only (pi's setters THROW on unknown) → exclude already-active → the names to actually
 * add (empty = nothing to set).
 */
function additiveActivation(registered: string[], current: string[], names: string[]): string[] {
  const known = new Set(registered);
  const active = new Set(current);
  return [...new Set(names)].filter((name) => known.has(name) && !active.has(name));
}
