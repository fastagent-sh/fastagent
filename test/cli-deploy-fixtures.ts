import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { flyTomlFile } from "../src/deploy/fly/plan.ts";

/** Whether `pid` runs: signal 0 only asks. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The variables a generated `fly.<name>.toml` sets on the box, as the box reads them. */
export async function flyVariables(dir: string, name: string): Promise<Record<string, string>> {
  const toml = await readFile(join(dir, flyTomlFile(name)), "utf8");
  const found = [...toml.matchAll(/^ {2}(FASTAGENT_(?:NAME|RELEASE_ID|CONFIG_JSON)) = (".*")$/gm)];
  return Object.fromEntries(found.map((m) => [m[1] as string, JSON.parse(m[2] as string) as string]));
}

/** The configuration a deploy of `dir` to Fly delivers, parsed. */
export async function flyConfig(dir: string, name: string): Promise<unknown> {
  return JSON.parse((await flyVariables(dir, name)).FASTAGENT_CONFIG_JSON as string);
}
