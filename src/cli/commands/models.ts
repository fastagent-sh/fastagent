/**
 * `fastagent models [search]`: print every "provider/modelId" pi-ai offers, plus, inside an agent, the providers its
 * definition declares; `[search]` filters by substring.
 */
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { listModels, modelsOver } from "../../harnesses/models/models.ts";
import { buildDefinition, prepareDefinition } from "../../harnesses/pi-durable/open.ts";
import { enterAgentEnv } from "../../env.ts";
import { formatModelsCommand } from "../models-view.ts";
import { failStartup, optionalAgentDirOrExit } from "../fail.ts";

export async function runModels(search: string | undefined, opts: { global?: boolean } = {}): Promise<void> {
  // "Outside an agent" must mean exactly that, as for `login`: refused inside an agent's subdirectory (findAgentDir);
  // `-g` asks for pi-ai's built-ins alone.
  const agentDir = opts.global ? undefined : optionalAgentDirOrExit(process.cwd());
  let providers: Parameters<typeof modelsOver>[1] = [];
  if (agentDir) {
    enterAgentEnv(agentDir); // a provider in code may need its secrets to be built
    providers = await prepareDefinition(agentDir)
      .then((definition) => buildDefinition(definition).providers)
      .catch(failStartup);
  }
  const { lines, error } = formatModelsCommand(
    listModels(modelsOver(new InMemoryCredentialStore(), providers)),
    search,
  );
  for (const spec of lines) console.log(spec);
  if (error) console.error(error);
}
