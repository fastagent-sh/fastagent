/**
 * Which Agent session each of a Caller's conversations talks in: a channel's chats and threads, a schedule's runs. The
 * Agent names sessions, so a Caller keeps this map, in its own state (a channel's `channels/<kind>/sessions.json`,
 * the schedules' `schedule/sessions.json`), and creates a conversation's session in one order (architecture.md §2):
 * the session, then the record, then the message. It is called where the Caller already serializes the conversation
 * (a channel's turn queue, a schedule's one loop), so two messages for one new conversation meet the map one after the
 * other. A crash between the session and the record
 * leaves a session nothing refers to, which the retry does not reuse; no message is answered twice, since a message is
 * sent only once its session is recorded.
 */
import { dirname } from "node:path";
import { type Agent, AgentError } from "./agent-api.ts";
import { log } from "./log.ts";
import { ensureStateHome, loadStateFile, saveStateFile } from "./state-file.ts";

/** What the map asks of the Agent: whether a recorded session is still there, and a new one when it is not. */
type SessionsAgent = { sessions: Pick<Agent["sessions"], "get" | "create"> };

/** A new, empty session: what a conversation the agent has not talked in starts with. */
export async function newSession(agent: SessionsAgent): Promise<string> {
  const created = await agent.sessions.create().catch((error: unknown) => {
    if (!(error instanceof AgentError)) throw error;
    throw new AgentError({ ...error, message: `creating a session failed: ${error.message}` });
  });
  return created.id;
}

export interface ConversationSessions {
  /** The session `conversation` was recorded with, when it has one, as recorded. */
  get(conversation: string): string | undefined;
  /**
   * The session `conversation` talks in: the one it has, or the one `create` makes (an empty one by default), recorded
   * before it is returned. A recorded session the Agent no longer holds (its storage was reset, or restored from an
   * older copy) is replaced the same way, and said so, rather than failing every message after it.
   */
  of(conversation: string, agent: SessionsAgent, create?: () => Promise<string>): Promise<string>;
}

/**
 * The map kept in `file`, read once and kept in memory: one process owns an instance's state, so nothing else writes
 * it while this process runs, and a turn costs no read of a file that grows with every conversation. Written whole,
 * synchronously, when a conversation gets a session.
 */
export function conversationSessions(file: string): ConversationSessions {
  let recorded: Map<string, string> | undefined;
  const map = (): Map<string, string> => {
    if (recorded === undefined) {
      const stored = loadStateFile(file);
      recorded = new Map(stored !== null && typeof stored === "object" ? Object.entries(stored) : []);
    }
    return recorded;
  };
  // A session asked about once is the Agent's for as long as this process runs: sessions are never deleted.
  const confirmed = new Set<string>();
  const held = async (agent: SessionsAgent, sessionId: string): Promise<boolean> => {
    if (confirmed.has(sessionId)) return true;
    const held = await agent.sessions.get(sessionId).then(
      () => true,
      (error: unknown) => {
        if (error instanceof AgentError && error.code === "not_found") return false;
        throw error;
      },
    );
    if (held) confirmed.add(sessionId);
    return held;
  };
  return {
    get: (conversation) => map().get(conversation),
    async of(conversation, agent, create = () => newSession(agent)) {
      const known = map().get(conversation);
      if (known !== undefined && (await held(agent, known))) return known;
      if (known !== undefined) {
        log.warn(
          `[fastagent] ${conversation}: its session ${known} is not in the agent's storage (reset, or restored from ` +
            `an older copy) — starting it a new one, recorded in ${file}`,
        );
      }
      const sessionId = await create();
      map().set(conversation, sessionId);
      ensureStateHome(dirname(file));
      saveStateFile(file, Object.fromEntries(map()));
      confirmed.add(sessionId);
      return sessionId;
    },
  };
}
