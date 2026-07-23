/** Best-effort bounded durable dedup ring, recorded only after the caller's pre-ACK side effect is durable. */
import { log } from "../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

export interface SeenRing {
  has(id: string): boolean;
  add(id: string): void;
}

export function createSeenRing(path: string, label: string, cap = 2000): SeenRing {
  const raw = loadStateFile(path);
  const order =
    raw === undefined
      ? []
      : Array.isArray(raw) && raw.every((id) => typeof id === "string")
        ? raw.slice(-cap)
        : undefined;
  if (order === undefined) log.warn(`${label} unexpected shape in ${path} — starting with no seen ids`);
  const values = order ?? [];
  const ids = new Set(values);
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return;
      ids.add(id);
      values.push(id);
      while (values.length > cap) {
        const evicted = values.shift();
        if (evicted !== undefined) ids.delete(evicted);
      }
      try {
        saveStateFile(path, values);
      } catch (error) {
        log.warn(`${label} seen-ring write failed (delivery dedup is in-memory until restart): ${String(error)}`);
      }
    },
  };
}
