/**
 * `fastagent models [search]`: print every "provider/modelId" the agent here can name (pi-ai's built-in providers
 * and the providers its definition declares), or, outside an agent, the built-ins; `[search]` filters by substring.
 */
import { definedValues } from "../../declared-secrets.ts";
import type { Provider } from "@earendil-works/pi-ai";
import { modelEnvironment } from "../../harnesses/models/environment.ts";
import { listModels, providerOf } from "../../harnesses/models/models.ts";
import { definitionProviders } from "../../harnesses/assembly.ts";
import { enterAgentEnv } from "../../env.ts";
import { readProcessEnv } from "../../process-env.ts";
import { installProxyFetch } from "../../proxy.ts";
import { formatModelsCommand } from "../models-view.ts";
import { failStartup, optionalAgentDirOrExit } from "../fail.ts";

export async function runModels(
  search: string | undefined,
  opts: { global?: boolean; json?: boolean } = {},
): Promise<void> {
  const agentDir = opts.global ? undefined : optionalAgentDirOrExit(process.cwd());
  let providers: Provider[] = [];
  if (agentDir) {
    enterAgentEnv(agentDir);
    providers = await definitionProviders(agentDir, readProcessEnv()).catch(failStartup);
  } else {
    installProxyFetch();
  }
  const environment = await modelEnvironment(agentDir, agentDir ? {} : { authPath: null }, providers, {
    environment: definedValues(readProcessEnv()),
  });
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
}
