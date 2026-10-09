/**
 * `fastagent models [search]`: print every "provider/modelId" the agent here (or, outside one or with `-g`, this
 * machine) can name; `[search]` filters by substring. `--refresh` first fetches the model catalog into that scope's
 * `models-store.json`.
 */
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { formatModelsCommand } from "../models-view.ts";
import { listModels } from "../../harnesses/pi/config.ts";
import { createPiModelRuntime, globalCatalogPath, machineModelRuntime } from "../../harnesses/pi/models.ts";
import { refreshMachineModelCatalog, refreshModelCatalog } from "../../harnesses/pi/open.ts";
import { AGENT_MODEL_CATALOG_FILE, globalHome } from "../../paths.ts";
import { enterAgentEnv } from "../../env.ts";
import { failStartup, optionalAgentDirOrExit } from "../fail.ts";

export async function runModels(
  search: string | undefined,
  opts: { refresh?: boolean; global?: boolean } = {},
): Promise<void> {
  const cwd = process.cwd();
  // "Outside an agent" must mean exactly that, as for `login`: inside an agent's subdirectory, falling back to the
  // machine would list without the agent's own catalog and models.json, and a refresh would record the models where no
  // deploy carries them. Refused there (findAgentDir); `-g` asks for the machine.
  const agentDir = opts.global ? undefined : optionalAgentDirOrExit(cwd);
  if (opts.refresh) {
    // pi fetches a provider's catalog only with a usable credential for it: the scope's own credentials and `.env`
    // keys, as `login` reads them.
    enterAgentEnv(agentDir ?? globalHome());
    if (agentDir) {
      await refreshModelCatalog(agentDir).catch(failStartup);
      console.error(
        `[fastagent] refreshed ${join(agentDir, AGENT_MODEL_CATALOG_FILE)} — commit it: it ships with a deploy`,
      );
    } else {
      await refreshMachineModelCatalog().catch(failStartup);
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
