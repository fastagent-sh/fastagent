import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TurnRecordBase, createTurnStore } from "../src/channels/kit/turn-store.ts";

export interface Stored extends TurnRecordBase {
  text: string;
}

export const dirs: string[] = [];

export function durable() {
  const dir = mkdtempSync(join(tmpdir(), "turn-runner-"));
  dirs.push(dir);
  const storePath = join(dir, "turns.json");
  const openStore = () =>
    createTurnStore<Stored>(storePath, {
      label: "[t]",
      isRecord: (r): r is Stored => typeof r === "object" && r !== null && "attempts" in r,
      order: (a, b) => a.id.localeCompare(b.id),
    });
  return { dir, storePath, openStore, store: openStore() };
}
