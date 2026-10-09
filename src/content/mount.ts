/**
 * The writes into `content/`, where each entry is on this machine: a link to a directory of it, or a clone. The
 * directory carries its own `.gitignore` (`*`), as `.secrets/` does: what is there belongs to this machine, never to
 * the definition, so it stays out of git even in an agent whose own `.gitignore` predates it.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTENT_DIRNAME } from "../paths.ts";

/** Make `dir`, the agent's `content/`, ready to hold an entry, and return it. */
export function ensureContentDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return dir;
}

/** Link `content/<name>` of the agent in `agentDir` to `target`, a directory of this machine. */
export function linkContent(agentDir: string, name: string, target: string): void {
  const dir = ensureContentDir(join(resolve(agentDir), CONTENT_DIRNAME));
  symlinkSync(target, join(dir, name), "dir");
}
