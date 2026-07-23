/** Durable, bounded unsummoned Slack discussion folded into the next answered turn in the same place. */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../state.ts";

const BUFFER_MAX_CHARS = 4000;
const BUFFER_ATTACH_MAX = 3;

export interface SlackBufferEntry {
  sender: string;
  body: string;
  messageId: string;
  replyTo?: string;
  fileIds?: string[];
}

export interface SlackBufferedFileRef {
  id: string;
  from: string;
  messageId: string;
}

function bufferLine(entry: SlackBufferEntry): string {
  const meta = [`msg ${entry.messageId}`, entry.replyTo ? `thread root ${entry.replyTo}` : undefined]
    .filter(Boolean)
    .join(", ");
  return `${entry.sender} (${meta}): ${entry.body}`;
}

export function collectSlackBufferedFiles(
  consumed: SlackBufferEntry[],
  primaryIds: Set<string>,
): { files: SlackBufferedFileRef[]; skipped: number } {
  const seen = new Set<string>();
  const files: SlackBufferedFileRef[] = [];
  for (const entry of consumed) {
    for (const id of entry.fileIds ?? []) {
      if (primaryIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      files.push({ id, from: entry.sender, messageId: entry.messageId });
    }
  }
  return { files: files.slice(-BUFFER_ATTACH_MAX), skipped: Math.max(0, files.length - BUFFER_ATTACH_MAX) };
}

export interface SlackContextBuffer {
  push(placeKey: string, entry: SlackBufferEntry): void;
  peek(placeKey: string): { text: string; consumed: SlackBufferEntry[] };
  commit(placeKey: string, consumed: SlackBufferEntry[]): void;
}

function isEntry(value: unknown): value is SlackBufferEntry {
  const entry = value as SlackBufferEntry;
  return (
    typeof entry?.sender === "string" &&
    typeof entry.body === "string" &&
    typeof entry.messageId === "string" &&
    (entry.replyTo === undefined || typeof entry.replyTo === "string") &&
    (entry.fileIds === undefined ||
      (Array.isArray(entry.fileIds) && entry.fileIds.every((id) => typeof id === "string")))
  );
}

export function createSlackContextBuffer(path: string, label = "[slack]"): SlackContextBuffer {
  const raw = loadStateFile(path);
  let buffers = new Map<string, SlackBufferEntry[]>();
  if (raw !== undefined) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.values(raw).every((entries) => Array.isArray(entries) && entries.every(isEntry))
    ) {
      buffers = new Map(Object.entries(raw as Record<string, SlackBufferEntry[]>));
    } else {
      log.warn(`${label} unexpected shape in ${path} — starting with an empty context buffer`);
    }
  }
  const persist = (): void => saveStateFile(path, Object.fromEntries(buffers));

  return {
    push(placeKey, entry) {
      const previous = buffers.get(placeKey);
      const entries = previous ? [...previous] : [];
      entries.push(entry);
      let total = entries.reduce((sum, candidate) => sum + bufferLine(candidate).length + 1, 0);
      while (entries.length > 1 && total > BUFFER_MAX_CHARS) {
        const dropped = entries.shift();
        if (dropped) total -= bufferLine(dropped).length + 1;
      }
      buffers.set(placeKey, entries);
      try {
        persist();
      } catch (error) {
        if (previous) buffers.set(placeKey, previous);
        else buffers.delete(placeKey);
        throw error;
      }
    },
    peek(placeKey) {
      const entries = buffers.get(placeKey) ?? [];
      return { text: entries.map(bufferLine).join("\n"), consumed: [...entries] };
    },
    commit(placeKey, consumed) {
      const entries = buffers.get(placeKey);
      if (!entries) return;
      const remaining = entries.filter((entry) => !consumed.includes(entry));
      if (remaining.length === 0) buffers.delete(placeKey);
      else buffers.set(placeKey, remaining);
      try {
        persist();
      } catch (error) {
        log.error(`${label} context-buffer write failed post-ACK (discussion may be folded again): ${String(error)}`);
      }
    },
  };
}
