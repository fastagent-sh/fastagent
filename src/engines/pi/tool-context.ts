/**
 * Per-turn capabilities shared by every FastAgent-defined tool. A tool is built once and reused across
 * turns, so current cwd/session/activation bindings ride AsyncLocalStorage rather than definition
 * closures. Deploy-time ambients a tool closes over at build time do NOT belong here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionEntry as PiSessionEntry, AgentSession } from "@earendil-works/pi-coding-agent";

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
   *  THROWS on them); answers the names actually newly activated (already-active names don't repeat).
   *
   *  SYNCHRONOUS, and that is the contract, not an implementation detail: read-modify-write against
   *  pi's active set cannot be interleaved as long as no caller can await inside it. An async
   *  signature would need a lock to say the same thing, and the lock is what a previous version had
   *  — one rebuilt per tool call, so the parallel batch it existed for never met on it. If pi's
   *  setters ever become async, this signature is where that breaks, loudly. */
  activate(names: string[]): string[];
}

/**
 * The activation bridge over a live pi session — the ONE implementation, for both consumers.
 *
 * Serving (`agent-session-factory.ts`) and chat (`session-builder.ts`) had a copy each, identical
 * but for the persistence line; the neighbouring `definitionResourceLoaderOptions` exists because
 * that exact duplication drifted once before. The difference is a PARAMETER now: `onActivated` is
 * what a served session uses to record the delta that carries the discovery into its next turn,
 * and chat has nowhere to put one (pi's SessionContext has no active-tool set).
 *
 * Bind it to the SESSION, never to a tool call: the next call has to see what this one activated.
 */
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

/** dedupe → keep registered names only (pi's setters THROW on unknown) → exclude already-active →
 *  the names to actually add (empty = nothing to set). */
function additiveActivation(registered: string[], current: string[], names: string[]): string[] {
  const known = new Set(registered);
  const active = new Set(current);
  return [...new Set(names)].filter((name) => known.has(name) && !active.has(name));
}
