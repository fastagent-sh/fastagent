/**
 * The `session` engine class's two tool-runtime bridges, shared by both of its consumers: the
 * resident runtime (`session-builder.ts`, driving pi's TUI) and the per-invoke L0
 * (`session-invoke.ts`). One copy, because a fastagent-defined tool must see the same session and
 * the same activation semantics whichever of the two is driving the turn — and because a MISSING
 * binding degrades silently (`tool-context.ts`: no store → cwd falls back to process.cwd(), the
 * manager and activation become undefined, so `wake` writes nowhere and `search_tools` is a no-op).
 */
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type ReadonlySessionManager, type ToolActivation, additiveActivation } from "./tool-context.ts";

/** Adapt a pi-coding-agent session's SessionManager to FastAgent's shared tool-runtime manager port
 *  — the session-class counterpart of invoke.ts's `toolSessionManager`. */
export function toolSessionManagerFromSession(session: AgentSession): ReadonlySessionManager {
  return {
    getSessionId: () => session.sessionManager.getSessionId(),
    async getHeader() {
      const header = session.sessionManager.getHeader();
      if (!header) throw new Error("session record has no metadata header");
      return { id: header.id, timestamp: header.timestamp };
    },
    async getBranch() {
      return session.sessionManager.getBranch() as SessionTreeEntry[];
    },
  };
}

/** The turn's {@link ToolActivation} over pi's AgentSession — the counterpart of invoke.ts's
 *  harness bridge, so the SAME builtin search_tools serves both paths. Additive; unknown names
 *  filtered (`setActiveToolsByName` is authoritative on the session and rebuilds its prompt — our
 *  static override keeps the prompt identical to serving). */
export function sessionToolActivation(session: AgentSession): ToolActivation {
  // Same serialization as invoke.ts's bridge: the read-modify-write below is only race-free while
  // nothing awaits between read and write, and pi's session setters happening to be synchronous
  // today is not a contract worth betting parallel tool batches on. One chain per BRIDGE, which is
  // sufficient because each consumer builds exactly one bridge per session object (the resident
  // runtime one per createAgentSession, the per-invoke L0 one per turn's session) — a second bridge
  // over the same session would not serialize against this one, and nothing constructs that.
  let chain: Promise<string[]> = Promise.resolve([]);
  return {
    active: () => session.getActiveToolNames(),
    registered: () => session.getAllTools().map((t) => ({ name: t.name, description: t.description ?? "" })),
    activate(names) {
      const run = async (): Promise<string[]> => {
        const current = session.getActiveToolNames();
        const added = additiveActivation(
          session.getAllTools().map((t) => t.name),
          current,
          names,
        );
        if (added.length > 0) session.setActiveToolsByName([...current, ...added]);
        return added;
      };
      const result = chain.then(run, run); // run after the predecessor settles, success or failure
      chain = result.catch(() => []); // the caller sees a rejection on `result`; the chain stays usable
      return result;
    },
  };
}
