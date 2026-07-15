/**
 * The per-turn context a tool's `execute` can read (beyond its abort signal): the SESSION the current
 * turn runs in. A `defineTool` tool is built ONCE and reused across sessions, so the session can't be a
 * closure — it rides an AsyncLocalStorage set around the harness turn (invoke.ts) and read inside
 * `execute` (tool.ts). Undefined outside a turn (e.g. `fastagent tool`, which runs a tool with no
 * session). This is what lets a tool know which conversation it is in — the mechanism the agent's
 * self-scheduling `wake` tool needs to fire a later turn back into the SAME session.
 *
 * Only `session` lives here (a per-turn runtime value). Deploy-time ambients a tool closes over at
 * build time (e.g. a stateRoot) do NOT belong here — pass them via the tool's own closure.
 */
import { AsyncLocalStorage } from "node:async_hooks";

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
  /** ADDITIVE activation. Unknown names are ignored (pi's own contract); resolves the names actually
   *  newly activated (already-active names don't repeat). */
  activate(names: string[]): Promise<string[]>;
}

export interface TurnContext {
  /** The session id of the current turn. */
  session: string;
  /** Tool activation for the current turn's harness. Absent outside a turn (`fastagent tool`). */
  tools?: ToolActivation;
}

export const turnContext = new AsyncLocalStorage<TurnContext>();
