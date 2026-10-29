/**
 * `fastagent models [search]`: print every "provider/modelId" the agent here can name (pi-ai's built-ins with their
 * published catalogs, and the providers its definition declares), or, outside an agent, the built-ins; `[search]`
 * filters by substring. `--refresh` asks the network for the lists even when the kept ones are fresh.
 */
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { modelEnvironment } from "../../harnesses/models/environment.ts";
import { listModels, providerOf } from "../../harnesses/models/models.ts";
import { definitionProviders } from "../../harnesses/pi-durable/open.ts";
import { enterAgentEnv } from "../../env.ts";
import { installProxyFetch } from "../../proxy.ts";
import { formatModelsCommand } from "../models-view.ts";
import { failStartup, optionalAgentDirOrExit } from "../fail.ts";

export async function runModels(
  search: string | undefined,
  opts: { global?: boolean; refresh?: boolean; json?: boolean } = {},
): Promise<void> {
  // "Outside an agent" must mean exactly that, as for `login`: refused inside an agent's subdirectory (findAgentDir);
  // `-g` asks for pi-ai's built-ins alone.
  const agentDir = opts.global ? undefined : optionalAgentDirOrExit(process.cwd());
  let providers: Provider[] = [];
  if (agentDir) {
    enterAgentEnv(agentDir); // a provider in code may read its secrets when it is built
    providers = await definitionProviders(agentDir).catch(failStartup);
  } else {
    installProxyFetch();
  }
  // Outside an agent, no credentials file is read: the built-ins' lists need none.
  const environment = await modelEnvironment(
    agentDir,
    agentDir ? {} : { credentialStore: new InMemoryCredentialStore() },
    providers,
    { force: opts.refresh === true },
  );
  const { lines, error } = formatModelsCommand(listModels(environment.models), search);
  if (opts.json) {
    const models = lines.map((spec) => {
      const provider = providerOf(spec);
      const id = spec.slice(provider.length + 1);
      return { spec, provider, id, name: environment.models.getModel(provider, id)?.name ?? id };
    });
    console.log(JSON.stringify(models, null, 2));
  } else {
    for (const spec of lines) console.log(spec);
    if (error) console.error(error);
  }
  // The list printed is the one kept; the warning above it said why it is not newer.
  if (opts.refresh && environment.catalogProblem !== undefined) process.exitCode = 1;
}
