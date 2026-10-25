/**
 * Which Agent session each place (a chat, a thread) talks in. The Agent names sessions, so a channel keeps this map,
 * in its own state (`<stateRoot>/channels/<kind>/sessions.json`), and creates a place's session in one order
 * (architecture.md §2): the session, then the record, then the message. It is called inside the place's turn queue,
 * so two messages for one new place meet the map one after the other. A crash between the session and the record
 * leaves a session nothing refers to, which the retry does not reuse; no message is answered twice, since a message is
 * sent only once its session is recorded.
 */
import { join } from "node:path";
import { ensureStateHome, loadStateFile, saveStateFile } from "./state.ts";

export interface PlaceSessions {
  /** The session `place` talks in, when it has one. */
  get(place: string): string | undefined;
  /** The session `place` talks in: the one it has, or the one `create` makes, recorded before it is returned. */
  of(place: string, create: () => Promise<string>): Promise<string>;
}

export function placeSessions(stateRoot: string, kind: string): PlaceSessions {
  const dir = join(stateRoot, "channels", kind);
  const file = join(dir, "sessions.json");
  // Read and written whole, synchronously: one process serves a channel kind, so nothing writes between them.
  const read = (): Record<string, string> => {
    const stored = loadStateFile(file);
    return stored !== null && typeof stored === "object" ? (stored as Record<string, string>) : {};
  };
  return {
    get: (place) => read()[place],
    async of(place, create) {
      const known = read()[place];
      if (known !== undefined) return known;
      const sessionId = await create();
      ensureStateHome(dir);
      saveStateFile(file, { ...read(), [place]: sessionId });
      return sessionId;
    },
  };
}
