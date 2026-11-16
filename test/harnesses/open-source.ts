import { loadSourceDefinition } from "../../packages/fastagent/src/harnesses/pi-durable/open.ts";
import {
  type LocalAgent,
  type OpenAgentOptions,
  openAgent,
} from "../../packages/fastagent/src/harnesses/pi-durable/serve.ts";

type SourceOptions = Omit<OpenAgentOptions, "root">;

/**
 * An instance of the source project in `dir`, rooted there and given this process's environment as its secrets, as
 * `dev` runs it: the way most tests open an agent.
 */
export async function openSource(
  dir: string,
  { secrets = process.env, ...options }: SourceOptions = {},
): Promise<LocalAgent> {
  return openAgent(await loadSourceDefinition(dir), { root: dir, secrets, offline: true, ...options });
}
