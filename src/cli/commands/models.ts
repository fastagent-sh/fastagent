/** `fastagent models [search]`: print every registered "provider/modelId"; `[search]` filters by substring. */
import { formatModelsCommand } from "../models-view.ts";
import { listModels } from "../../engines/pi/config.ts";
import { createPiModels } from "../../engines/pi/models.ts";

export function runModels(search: string | undefined): void {
  const { lines, error } = formatModelsCommand(listModels(createPiModels()), search);
  for (const spec of lines) console.log(spec);
  if (error) console.error(error);
}
