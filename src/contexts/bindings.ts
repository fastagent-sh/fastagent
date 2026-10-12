/**
 * Revoke bindings around a snapshot publication/removal under context.json's lock. Keeping a withdrawn path-only
 * binding would turn a readonly checkout into writable local data; a failed publication must restore the old bindings.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { localContextFileText, parseContextCopy, parseLocalContextFile } from "../content/file.ts";
import { LOCAL_CONTEXT_FILE, contextCopyPath } from "../paths.ts";
import { COPY_RECORD, readCopyRecord } from "./copy.ts";
import { contextSource } from "./declare.ts";

export function withRevokedContextBindings(
  agentDir: string,
  name: string,
  retained: readonly string[],
  publish: () => void,
): void {
  const path = join(agentDir, LOCAL_CONTEXT_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      publish();
      return;
    }
    throw new Error(`${path} could not be read: ${(error as Error).message}`);
  }
  const local = parseLocalContextFile(text, path, [], agentDir);
  if (Object.keys(local.content).length === 0) {
    publish();
    return;
  }
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
  if (Object.keys(bindings).length === Object.keys(local.content).length) {
    publish();
    return;
  }
  const mode = statSync(path).mode & 0o777;
  writeFileAtomic(path, localContextFileText(bindings), mode);
  try {
    publish();
  } catch (error) {
    // The declaration lock excludes other binding writers: restoring these bytes restores the pre-publication state.
    try {
      writeFileAtomic(path, text, mode);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `context "${name}" publication failed (${String(error)}) and bindings at ${path} could not be restored ` +
          `(${String(restoreError)})`,
      );
    }
    throw error;
  }
}
