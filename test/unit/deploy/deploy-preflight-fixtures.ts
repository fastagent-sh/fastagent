import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightDeploy } from "../../../src/deploy/preflight.ts";
import { type EffectiveConfig, resolveConfig } from "../../../src/harnesses/pi-durable/config.ts";
import { defineDefinition } from "../../../src/harnesses/pi-durable/definition.ts";

/** An agent directory, as `init` produces one; `files` land in it. Named `agent`: a deployed agent's name is its
 *  directory's, and the temp prefix would not pass the release-name rule. */
export async function agent(files: Record<string, string> = {}): Promise<string> {
  const host = await mkdtemp(join(tmpdir(), "fa-preflight-"));
  const dir = join(host, "agent");
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n"); // THE marker
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "*" } }),
  );
  // Real credential files: the leak gate only fires on paths that EXIST (nothing else can be baked).
  await writeFile(join(dir, ".secrets", "auth.json"), "{}\n");
  await writeFile(join(dir, ".secrets", ".env"), "K=v\n");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true }); // a fixture may name a nested file (schedules/…)
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** The values of a configuration a test sets; the rest is what an empty one resolves to. */
export type FastagentConfig = Pick<EffectiveConfig, "model" | "thinkingLevel" | "http" | "deploy">;

const empty = resolveConfig(
  defineDefinition({
    format: 1,
    builtWith: "0.0.0",
    name: "empty",
    version: "0.0.0",
    dir: "/empty",
    config: {},
    registry: { tools: [], extensions: [], channels: [], schedules: [] },
  }),
);

export const call = (
  target: string,
  config: FastagentConfig,
  over: Partial<Parameters<typeof preflightDeploy>[0]> = {},
) =>
  preflightDeploy({
    agentDir: target,
    name: "agent",
    config: { ...empty, ...config },
    run: false,
    force: false,
    ...over,
  });
