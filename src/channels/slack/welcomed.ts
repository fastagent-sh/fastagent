/** Durable set of users who have already received the first-run DM welcome, so it is sent at most once. */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../state.ts";

export interface WelcomedUsers {
  has(teamId: string, userId: string): boolean;
  add(teamId: string, userId: string): void;
}

function key(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

export function createWelcomedUsers(path: string, label = "[slack]"): WelcomedUsers {
  const raw = loadStateFile(path);
  let ids = new Set<string>();
  if (raw !== undefined) {
    if (Array.isArray(raw) && raw.every((id) => typeof id === "string")) {
      ids = new Set(raw as string[]);
    } else {
      log.warn(`${label} unexpected shape in ${path} — starting with no welcomed users`);
    }
  }
  return {
    has(teamId, userId) {
      return ids.has(key(teamId, userId));
    },
    add(teamId, userId) {
      const id = key(teamId, userId);
      if (ids.has(id)) return;
      const next = new Set(ids);
      next.add(id);
      saveStateFile(path, [...next]);
      ids = next;
    },
  };
}
