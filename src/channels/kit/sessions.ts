/**
 * Which Agent session each of a channel's conversations (a chat, a thread, what a route names) talks in. The Agent
 * names sessions, so a channel keeps this map, in its own state (`<stateRoot>/channels/<kind>/sessions.json`), and
 * creates a conversation's session in one order (architecture.md §2): the session, then the record, then the message.
 * It is called inside the conversation's turn queue, so two messages for one new conversation meet the map one after
 * the other. A crash between the session and the record
 * leaves a session nothing refers to, which the retry does not reuse; no message is answered twice, since a message is
 * sent only once its session is recorded.
 */
import { join } from "node:path";
import type { Agent } from "../../agent-api.ts";
import { ensureStateHome, loadStateFile, saveStateFile } from "./state.ts";

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

export function conversationSessions(stateRoot: string, kind: string): ConversationSessions {
  const dir = join(stateRoot, "channels", kind);
  const file = join(dir, "sessions.json");
  // Read and written whole, synchronously: one process serves a channel kind, so nothing writes between them.
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
      ensureStateHome(dir);
      saveStateFile(file, { ...read(), [conversation]: sessionId });
      return sessionId;
    },
  };
}
