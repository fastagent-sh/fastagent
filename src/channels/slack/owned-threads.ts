/** Durable roots of Slack group threads entered by an explicit summon. */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../state.ts";

interface OwnedSlackThread {
  teamId: string;
  channelId: string;
  rootTs: string;
  createdAt: number;
}

interface OwnedSlackThreads {
  has(teamId: string, channelId: string, rootTs: string): boolean;
  add(teamId: string, channelId: string, rootTs: string): void;
}

function key(teamId: string, channelId: string, rootTs: string): string {
  return `${teamId}:${channelId}:${rootTs}`;
}

function isRecord(value: unknown): value is OwnedSlackThread {
  const record = value as OwnedSlackThread;
  return (
    typeof record?.teamId === "string" &&
    typeof record.channelId === "string" &&
    typeof record.rootTs === "string" &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt)
  );
}

export function createOwnedSlackThreads(
  path: string,
  label = "[slack]",
  now: () => number = Date.now,
): OwnedSlackThreads {
  const raw = loadStateFile(path);
  let records = new Map<string, OwnedSlackThread>();
  if (raw !== undefined) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.entries(raw).every(
        ([id, record]) => isRecord(record) && key(record.teamId, record.channelId, record.rootTs) === id,
      )
    ) {
      records = new Map(Object.entries(raw as Record<string, OwnedSlackThread>));
    } else {
      log.warn(`${label} unexpected shape in ${path} — starting with no managed Slack threads`);
    }
  }

  return {
    has(teamId, channelId, rootTs) {
      return records.has(key(teamId, channelId, rootTs));
    },
    add(teamId, channelId, rootTs) {
      const id = key(teamId, channelId, rootTs);
      if (records.has(id)) return;
      const next = new Map(records);
      next.set(id, { teamId, channelId, rootTs, createdAt: now() });
      saveStateFile(path, Object.fromEntries(next));
      records = next;
    },
  };
}
