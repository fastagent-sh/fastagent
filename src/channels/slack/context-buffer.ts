/**
 * Slack's half of the shared context buffer (mechanics + consume protocol: ../kit/context-buffer.ts): the entry shape,
 * its fold-line rendering, and buffered-file selection.
 */
import {
  capBufferedRefs,
  type ContextBuffer,
  createContextBuffer as createGenericContextBuffer,
} from "../kit/context-buffer.ts";

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
  const capped = capBufferedRefs(files);
  return { files: capped.kept, skipped: capped.skipped };
}

export type SlackContextBuffer = ContextBuffer<SlackBufferEntry>;

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

export function createSlackContextBuffer(path: string, label: string): SlackContextBuffer {
  return createGenericContextBuffer({ path, label, isEntry, line: bufferLine });
}
