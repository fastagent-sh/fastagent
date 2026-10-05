/** Per-turn capabilities shared by every FastAgent-defined tool. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionEntry as PiSessionEntry, AgentSession } from "@earendil-works/pi-coding-agent";
import type { ResolvedContext } from "../../contexts/resolve.ts";

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
 * activate deferred tools mid-turn without tool.ts importing the engine. pi anchors the addition in the transcript
 * (a system message carrying `toolsAdded`, written after the batch of tool results the activating call belongs to),
 * so providers with native deferred loading keep their
 * prompt-cache prefix. The same transcript declarations restore the loadout on the next binding.
 */
export interface ToolActivation {
  /** Names of the currently ACTIVE tools. */
  active(): string[];
  /** Every registered tool (active or not). */
  registered(): Array<{ name: string; description: string }>;
  /**
   * ADDITIVE activation. Returns ONLY the names this call actually added — a name a batch sibling activated first
   * is not in it. That return value is the caller's truth for both what to report and what to charge an activation
   * cap: the call is atomic, but an `active()` -> await -> `activate()` sequence around it is not.
   */
  activate(names: string[]): string[];
}

/** The activation bridge over a live pi session — the ONE implementation, for both consumers. */
export function sessionToolActivation(session: AgentSession): ToolActivation {
  return {
    active: () => session.getActiveToolNames(),
    registered: () => session.getAllTools().map((t) => ({ name: t.name, description: t.description ?? "" })),
    activate(names) {
      const current = session.getActiveToolNames();
      session.setActiveToolsByName([...current, ...names]);
      const before = new Set(current);
      return session.getActiveToolNames().filter((name) => !before.has(name));
    },
  };
}

export interface TurnContext {
  /** Working directory for this execution. */
  cwd?: string;
  /** The agent's contexts, resolved. */
  contexts?: readonly ResolvedContext[];
  sessionManager?: ReadonlySessionManager;
  tools?: ToolActivation;
}

export const turnContext = new AsyncLocalStorage<TurnContext>();
