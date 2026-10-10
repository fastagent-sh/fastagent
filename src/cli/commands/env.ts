/** `fastagent env <mise args…>`: the agent's own mise, run in the agent directory on its `mise.toml` alone. */
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { MISE_FILE, MISE_LOCK_FILE, readEnvironment } from "../../environment/declare.ts";
import { ensureMise, execMise } from "../../environment/mise.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";

/** The files mise writes for the agent. */
const WRITTEN = [MISE_FILE, MISE_LOCK_FILE] as const;

export async function runEnv(args: string[]): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
  const bin = await ensureMise(agentDir).catch(failStartup);
  const before = WRITTEN.map((name) => readIfPresent(join(agentDir, name)));
  const code = await execMise(agentDir, bin, args).catch(failStartup);
  // Checked by the command that wrote it, and undone: mise writes what FastAgent refuses too (`set` writes [env]), and
  // a refused file left in place stops the next start, which on a host only a new release repairs. The agent runs
  // this command on itself.
  try {
    readEnvironment(agentDir);
  } catch (error) {
    const changed = WRITTEN.filter((name, i) => readIfPresent(join(agentDir, name)) !== before[i]);
    if (changed.length === 0) failStartup(error);
    for (const [i, name] of WRITTEN.entries()) restore(join(agentDir, name), before[i]);
    failStartup(new Error(`${(error as Error).message} — this command's change to ${changed.join(" and ")} is undone`));
  }
  if (code !== 0) process.exit(code);
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function restore(path: string, content: string | undefined): void {
  if (content === undefined) rmSync(path, { force: true });
  else writeFileAtomic(path, content);
}
