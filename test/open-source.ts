import { loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { type LocalAgent, type OpenAgentOptions, openAgent } from "../src/harnesses/pi-durable/serve.ts";

type SourceOptions = Omit<Extract<OpenAgentOptions, { root: string }>, "root"> & { stateDir?: string };

/** An instance of the source project in `dir`, rooted there as `dev` runs it: the way most tests open an agent. */
export async function openSource(dir: string, { stateDir, ...options }: SourceOptions = {}): Promise<LocalAgent> {
  return openAgent(
    await loadSourceDefinition(dir),
    stateDir === undefined ? { root: dir, ...options } : { workdir: dir, stateDir, ...options },
  );
}
