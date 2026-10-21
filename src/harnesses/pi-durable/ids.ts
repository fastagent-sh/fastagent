/**
 * The ids the Agent hands out: the storage's incarnation, then pi-durable's id. pi-durable counts ids per storage and a
 * new storage counts from the start again, so an id kept from a storage that is gone must not name what the new one
 * gives the same number (architecture.md §2). An encoding, not a lookup: nothing is stored per id.
 */
import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { type Harness, defineDoc } from "@earendil-works/pi-durable";

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
}

export async function storageIds(harness: Harness, context: Context): Promise<Ids> {
  const incarnation = await harness.commit(async (tx) => {
    const doc = await tx.doc(StorageDoc);
    if (doc.incarnation === "") doc.incarnation = randomBytes(8).toString("base64url");
    return doc.incarnation;
  }, context);
  return idsOf(incarnation);
}

function idsOf(incarnation: string): Ids {
  const prefix = `${incarnation}.`;
  return {
    encode: (id) => `${prefix}${id}`,
    decode: (text) => {
      if (!text.startsWith(prefix)) return undefined;
      const digits = text.slice(prefix.length);
      if (!/^[1-9][0-9]{0,15}$/.test(digits)) return undefined;
      const id = Number(digits);
      return Number.isSafeInteger(id) ? id : undefined;
    },
  };
}
