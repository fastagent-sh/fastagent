/** pi's published catalog as catalog.ts keeps it in a catalogs directory, after a refresh just now. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyModel } from "@earendil-works/pi-ai";

/** The pi-ai these tests run, as the catalog asks pi.dev for it. */
export const PI_AI_VERSION = (
  JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Keep, in `dir` (an agent's is `<state root>/models`), a catalog fetched just now for `piAi`, listing `models`. */
export function keepCatalog(dir: string, models: readonly AnyModel[], piAi = PI_AI_VERSION): void {
  mkdirSync(dir, { recursive: true });
  const byProvider: Record<string, AnyModel[]> = {};
  for (const model of models) byProvider[model.provider] = [...(byProvider[model.provider] ?? []), model];
  const kept = { piAi, lastModified: Date.now(), checkedAt: Date.now(), models: byProvider };
  writeFileSync(join(dir, "published.json"), JSON.stringify(kept));
}
