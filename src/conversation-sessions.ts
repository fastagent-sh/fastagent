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
import type { Agent } from "./agent-api.ts";
import { ensureStateHome, loadStateFile, saveStateFile } from "./state-file.ts";

/** A new, empty session: what a conversation the agent has not talked in starts with. */
export async function newSession(agent: Pick<Agent, "createSession">): Promise<string> {
  const created = await agent.createSession();
  if (!created.ok) throw new Error(`creating a session failed: ${created.error.message}`);
  return created.sessionId;
}

export interface ConversationSessions {
  /** The session `conversation` talks in, when it has one. */
  get(conversation: string): string | undefined;
  /** The session `conversation` talks in: the one it has, or the one `create` makes, recorded before it is returned. */
  of(conversation: string, create: () => Promise<string>): Promise<string>;
}

/** The map kept in `file`. */
export function conversationSessions(file: string): ConversationSessions {
  // Read and written whole, synchronously: one process owns an instance's state, so nothing writes between them.
  const read = (): Record<string, string> => {
    const stored = loadStateFile(file);
    return stored !== null && typeof stored === "object" ? (stored as Record<string, string>) : {};
  };
  return {
    get: (conversation) => read()[conversation],
    async of(conversation, create) {
      const known = read()[conversation];
      if (known !== undefined) return known;
      const sessionId = await create();
      ensureStateHome(dirname(file));
      saveStateFile(file, { ...read(), [conversation]: sessionId });
      return sessionId;
    },
  };
}
