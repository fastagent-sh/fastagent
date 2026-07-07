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

export interface TurnContext {
  /** The session id of the current turn. */
  session: string;
}

export const turnContext = new AsyncLocalStorage<TurnContext>();
