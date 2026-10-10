/** `fastagent env <mise args…>`: the agent's own mise, run in the agent directory on its `mise.toml` alone. */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { MISE_FILE, MISE_LOCK_FILE, MISE_LOCK_SIDECARS, readEnvironment } from "../../environment/declare.ts";
import { ensureMise, execMise } from "../../environment/mise.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";

/** The files mise writes for the agent. */
const WRITTEN = [MISE_FILE, MISE_LOCK_FILE] as const;

/** What the agent's environment was before a command: the files, and a copy of the lock's sidecars, if any. */
interface Snapshot {
  files: (string | undefined)[];
  sidecars?: string;
}

export async function runEnv(args: string[]): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
  const bin = await ensureMise(agentDir).catch(failStartup);
  const before = takeSnapshot(agentDir);
  const { code, refusal } = await execMise(agentDir, bin, args)
    .then((code) => ({ code, refusal: undoIfRefused(agentDir, before) }))
    .finally(() => {
      if (before.sidecars) rmSync(before.sidecars, { recursive: true, force: true });
    })
    .catch(failStartup);
  if (refusal) failStartup(refusal);
  if (code !== 0) process.exit(code);
}

/**
 * Checked by the command that wrote it, and undone: mise writes what FastAgent refuses too (`set` writes [env]), and a
 * refused file left in place stops the next start, which on a host only a new release repairs. The agent runs this
 * command on itself. A file refused before the command is reported as it is.
 */
function undoIfRefused(agentDir: string, before: Snapshot): Error | undefined {
  try {
    readEnvironment(agentDir);
    return undefined;
  } catch (error) {
    const changed = WRITTEN.filter((name, i) => readIfPresent(join(agentDir, name)) !== before.files[i]);
    if (changed.length === 0) return error as Error;
    restoreSnapshot(agentDir, before);
    return new Error(`${(error as Error).message} — this command's change to ${changed.join(" and ")} is undone`);
  }
}

function takeSnapshot(agentDir: string): Snapshot {
  const files = WRITTEN.map((name) => readIfPresent(join(agentDir, name)));
  const sidecars = join(agentDir, MISE_LOCK_SIDECARS);
  if (!existsSync(sidecars)) return { files };
  const copy = mkdtempSync(join(tmpdir(), "fastagent-env-"));
  cpSync(sidecars, copy, { recursive: true });
  return { files, sidecars: copy };
}

/** The sidecars go back with the lock: it names them by digest. */
function restoreSnapshot(agentDir: string, before: Snapshot): void {
  for (const [i, name] of WRITTEN.entries()) {
    const path = join(agentDir, name);
    const content = before.files[i];
    if (content === undefined) rmSync(path, { force: true });
    else writeFileAtomic(path, content);
  }
  const sidecars = join(agentDir, MISE_LOCK_SIDECARS);
  rmSync(sidecars, { recursive: true, force: true });
  if (before.sidecars) cpSync(before.sidecars, sidecars, { recursive: true });
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
