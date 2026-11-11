import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { instanceName } from "../instance-name.ts";
import { readTextIfExists } from "../paths.ts";

/**
 * The name of the deployment of the agent in `agentDir` that `configFile` configures: the instance's own name, which is
 * what a host's resources and the generated manifests are called. It is the configuration's `name`, else the program's
 * (`package.json`'s, else the directory's) as one segment, which is what `info().name` says of an instance that gives
 * none. The one place a deployment is named, read by `deploy` and by every command that addresses a deployment.
 */
export async function deploymentName(agentDir: string, configFile?: string): Promise<string> {
  const pkg = JSON.parse((await readTextIfExists(join(agentDir, "package.json"))) ?? "{}") as { name?: unknown };
  const program = typeof pkg.name === "string" ? pkg.name : basename(resolve(agentDir));
  if (configFile === undefined) return instanceName(program);
  const path = resolve(configFile);
  let values: unknown;
  try {
    values = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the instance configuration ${path}: ${(error as Error).message}`, { cause: error });
  }
  const given = (values as { name?: unknown } | null)?.name;
  if (given !== undefined && typeof given !== "string") throw new Error(`${path}: "name" must be a string`);
  return instanceName(program, given);
}
