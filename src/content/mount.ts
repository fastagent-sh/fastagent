/**
 * The agent's `content/`, where fastagent clones the repositories `context.json` declares. The directory carries its
 * own `.gitignore` (`*`), as `.secrets/` does: each clone is its repository's, never the definition's, so it stays out
 * of git even in an agent whose own `.gitignore` predates it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Make `dir`, the agent's `content/`, ready to hold a clone, and return it. */
export function ensureContentDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return dir;
}
