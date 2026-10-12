/**
 * Revoke bindings whose content disappeared from a context. Refresh and remove call this under context.json's lock,
 * before replacing or deleting the old snapshot; otherwise a path-only checkout binding becomes writable local data.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { localContextFileText, parseContextCopy, parseLocalContextFile } from "../content/file.ts";
import { LOCAL_CONTEXT_FILE, contextCopyPath } from "../paths.ts";
import { COPY_RECORD, readCopyRecord } from "./copy.ts";
import { contextSource } from "./declare.ts";

export function unbindContextContent(agentDir: string, name: string, retained: readonly string[] = []): void {
  const path = join(agentDir, LOCAL_CONTEXT_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`${path} could not be read: ${(error as Error).message}`);
  }
  const local = parseLocalContextFile(text, path, [], agentDir);
  if (Object.keys(local.content).length === 0) return;
  if (!existsSync(join(contextCopyPath(agentDir, name), COPY_RECORD))) {
    throw new Error(
      `context "${name}" has no cached snapshot: cannot attribute local bindings safely — restore its old snapshot ` +
        `or remove the affected bindings from ${LOCAL_CONTEXT_FILE} before retrying`,
    );
  }
  // Removal may follow an unsuccessful edit of repository/ref: use the copy that supplied the bindings, not that edit.
  const previous = parseContextCopy(readCopyRecord(agentDir, name).declaration, contextSource(name));
  const kept = new Set(retained.map((entry) => entry.toLowerCase()));
  const revoked = new Set(
    previous.content.map((entry) => entry.name.toLowerCase()).filter((entry) => !kept.has(entry)),
  );
  const bindings = Object.fromEntries(
    Object.entries(local.content).filter(([entry]) => !revoked.has(entry.toLowerCase())),
  );
  if (Object.keys(bindings).length !== Object.keys(local.content).length) {
    writeFileAtomic(path, localContextFileText(bindings), statSync(path).mode & 0o777);
  }
}
