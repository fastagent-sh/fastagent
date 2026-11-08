import { loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { type LocalAgent, type OpenAgentOptions, openAgent } from "../src/harnesses/pi-durable/serve.ts";

type SourceOptions = Omit<Extract<OpenAgentOptions, { root: string }>, "root"> & { stateDir?: string };

/**
 * An instance of the source project in `dir`, rooted there and given this process's environment as its secrets, as
 * `dev` runs it: the way most tests open an agent.
 */
export async function openSource(
  dir: string,
  { stateDir, secrets = process.env, ...options }: SourceOptions = {},
): Promise<LocalAgent> {
  return openAgent(
    await loadSourceDefinition(dir),
    stateDir === undefined
      ? { root: dir, secrets, offline: true, ...options }
      : { workdir: dir, stateDir, secrets, offline: true, ...options },
  );
}
