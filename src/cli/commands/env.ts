/** `fastagent env <mise args…>`: the agent's own mise, run in the agent directory on its `mise.toml` alone. */
import { resolve } from "node:path";
import { readEnvironment } from "../../environment/declare.ts";
import { ensureMise, execMise } from "../../environment/mise.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";

export async function runEnv(args: string[]): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
  const bin = await ensureMise(agentDir).catch(failStartup);
  const code = await execMise(agentDir, bin, args).catch(failStartup);
  if (code !== 0) process.exit(code);
  // Said now, by the command that wrote it, rather than by the next start: mise writes what FastAgent refuses too.
  try {
    readEnvironment(agentDir);
  } catch (error) {
    failStartup(error);
  }
}
