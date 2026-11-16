/** `fastagent build [agent] [--no-check] [--json]`: the agent compiled into `dist/`. */
import { relative, resolve } from "node:path";
import { buildProject } from "../../harnesses/pi-durable/build.ts";
import { log } from "../../log.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";

export interface BuildCommandOptions {
  check: boolean;
  json: boolean;
}

export async function runBuild(dirArg: string, opts: BuildCommandOptions): Promise<void> {
  const dir = agentDirOrExit(resolve(dirArg));
  const { dist, definition, warnings } = await buildProject(dir, { check: opts.check }).catch(failStartup);
  for (const warning of warnings) log.warn(`[fastagent] ${warning}`);
  if (opts.json) {
    console.log(JSON.stringify({ dist, name: definition.name, version: definition.version, warnings }));
    return;
  }
  console.log(relative(process.cwd(), dist) || dist);
}
