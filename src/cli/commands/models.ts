/**
 * `fastagent models [search]`: print every "provider/modelId" the agent here (or, outside one or with `-g`, this
 * machine) can name; `[search]` filters by substring. `--refresh` first fetches the model catalog into that scope's
 * `models-store.json`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { formatModelsCommand } from "../models-view.ts";
import { listModels } from "../../engines/pi/config.ts";
import {
  createPiModelRuntime,
  globalCatalogPath,
  machineModelRuntime,
  refreshGlobalModelCatalog,
} from "../../engines/pi/models.ts";
import { refreshModelCatalog } from "../../engines/pi/open.ts";
import { AGENT_MODEL_CATALOG_FILE, GLOBAL_HOME_DIR, findAgentDir } from "../../paths.ts";
import { enterAgentEnv } from "../../env.ts";
import { failStartup } from "../fail.ts";

export async function runModels(
  search: string | undefined,
  opts: { refresh?: boolean; global?: boolean } = {},
): Promise<void> {
  const agentDir = opts.global ? undefined : findAgentDir(process.cwd());
  if (opts.refresh) {
    // pi fetches a provider's catalog only with a usable credential for it: the scope's own credentials and `.env`
    // keys, as `login` reads them.
    enterAgentEnv(agentDir ?? join(homedir(), GLOBAL_HOME_DIR));
    if (agentDir) {
      await refreshModelCatalog(agentDir).catch(failStartup);
      console.error(
        `[fastagent] refreshed ${join(agentDir, AGENT_MODEL_CATALOG_FILE)} — commit it: it ships with a deploy`,
      );
    } else {
      await refreshGlobalModelCatalog().catch(failStartup);
      console.error(`[fastagent] refreshed ${globalCatalogPath()} — every agent on this machine reads it`);
    }
  }
  const models = await (agentDir
    ? createPiModelRuntime({ agentDir, credentials: new InMemoryCredentialStore() })
    : machineModelRuntime()
  ).catch(failStartup);
  const { lines, error } = formatModelsCommand(listModels(models), search);
  for (const spec of lines) console.log(spec);
  if (error) console.error(error);
}
