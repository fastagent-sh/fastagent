/**
 * The ids the Agent hands out: the storage's incarnation, then pi-durable's id. pi-durable counts ids per storage and a
 * new storage counts from the start again, so an id kept from a storage that is gone must not name what the new one
 * gives the same number (architecture.md §2). An encoding, not a lookup: nothing is stored per id.
 */
import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { type Harness, type ToolExecutionApi, defineDoc } from "@earendil-works/pi-durable";
import { isSession } from "./sessions.ts";

const StorageDoc = defineDoc<{ incarnation: string }>({
  kind: "fastagent.storage",
  version: 1,
  scope: "session",
  initial: () => ({ incarnation: "" }),
});

export interface Ids {
  encode(id: number): string;
  /** The pi-durable id `text` names in this storage, or undefined for any other text. */
  decode(text: string): number | undefined;
  /** A position among this storage's ids as a cursor, which no id reads as. */
  encodeCursor(position: number): string;
  decodeCursor(text: string): number | undefined;
}

export async function storageIds(harness: Harness, context: Context): Promise<Ids> {
  const incarnation = await harness.commit(async (tx) => {
    const doc = await tx.doc(StorageDoc);
    if (doc.incarnation === "") doc.incarnation = randomBytes(8).toString("base64url");
    return doc.incarnation;
  }, context);
  return idsOf(incarnation);
}

/**
 * The session id of the conversation a tool runs in, as the Agent hands it out, or undefined when that conversation is
 * not a session (a subagent's): from the storage the tool runs on.
 */
export async function sessionIdOf(
  api: Pick<ToolExecutionApi, "conversationId" | "snapshot" | "commit">,
  context: Context,
): Promise<string | undefined> {
  const record = await api.commit((tx) => tx.conversation(api.conversationId), context);
  if (record === undefined || !isSession(record)) return undefined;
  const incarnation = (await api.snapshot(StorageDoc, context))?.incarnation;
  if (!incarnation) throw new Error("this storage has no incarnation: the Agent did not open it");
  return idsOf(incarnation).encode(api.conversationId);
}

function idsOf(incarnation: string): Ids {
  const prefix = `${incarnation}.`;
  const cursorPrefix = `${incarnation}~`;
  return {
    encode: (id) => `${prefix}${id}`,
    decode: (text) => numberAfter(prefix, text),
    encodeCursor: (position) => `${cursorPrefix}${position}`,
    decodeCursor: (text) => numberAfter(cursorPrefix, text),
  };
}

function numberAfter(prefix: string, text: string): number | undefined {
  if (!text.startsWith(prefix)) return undefined;
  const digits = text.slice(prefix.length);
  if (!/^[1-9][0-9]{0,15}$/.test(digits)) return undefined;
  const id = Number(digits);
  return Number.isSafeInteger(id) ? id : undefined;
}
