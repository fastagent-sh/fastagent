/** `fastagent models [search]`: print every "provider/modelId" this machine offers; `[search]` filters by substring. */
import { formatModelsCommand } from "../models-view.ts";
import { listModels } from "../../engines/pi/config.ts";
import { machineModelRuntime } from "../../engines/pi/models.ts";
import { refreshModelCatalog } from "../../engines/pi/open.ts";
import { findAgentDir } from "../../paths.ts";
import { enterAgentEnv } from "../../env.ts";
import { failStartup, failUsage } from "../fail.ts";

export async function runModels(search: string | undefined, opts: { refresh?: boolean } = {}): Promise<void> {
  if (opts.refresh) {
    // pi fetches a provider's catalog only with a usable credential for it, so a refresh needs an agent's credentials:
    // its auth.json and the keys in its `.env`.
    const agentDir = findAgentDir(process.cwd());
    if (!agentDir) failUsage("--refresh uses the credentials of the agent in this directory — run it inside one");
    enterAgentEnv(agentDir);
    await refreshModelCatalog(agentDir).catch(failStartup);
    console.error("[fastagent] model catalog refreshed");
  }
  const { lines, error } = formatModelsCommand(listModels(await machineModelRuntime().catch(failStartup)), search);
  for (const spec of lines) console.log(spec);
  if (error) console.error(error);
}
