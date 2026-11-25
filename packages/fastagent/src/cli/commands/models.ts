/**
 * `fastagent models [search]`: print every "provider/modelId" the agent here can name (pi-ai's built-in providers
 * and the providers its definition declares), or, outside an agent, the built-ins; `[search]` filters by substring.
 */
import { listModels, providerOf } from "../../harnesses/models/models.ts";
import { formatModelsCommand } from "../models-view.ts";
import { enterCliModelContext } from "../shared.ts";

export async function runModels(
  search: string | undefined,
  opts: { global?: boolean; json?: boolean } = {},
): Promise<void> {
  const { environment } = await enterCliModelContext({
    ...(opts.global === undefined ? {} : { global: opts.global }),
    noAgentEnv: "proxy",
    readGlobalAuth: false,
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
