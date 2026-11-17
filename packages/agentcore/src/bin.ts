#!/usr/bin/env node
/**
 * `fastagent-agentcore [dir]`: a container's command on AgentCore. It serves the build in `<dir>/dist` (`fastagent
 * build`), with its instances in the Aurora DSQL cluster `FASTAGENT_DSQL_ENDPOINT` names, and the runtime's environment
 * variables as the agent's secrets, as `fastagent start` takes them.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentDefinition, baseEnv } from "@fastagent-sh/fastagent";
import { dsqlDatabase } from "./dsql.ts";
import { serveAgentCore } from "./runtime.ts";

const ENDPOINT_ENV = "FASTAGENT_DSQL_ENDPOINT";

async function loadBuild(dir: string): Promise<AgentDefinition> {
  const dist = join(dir, "dist");
  const manifest = await readFile(join(dist, "package.json"), "utf8").catch(() => {
    throw new Error(`there is no build in ${dist}: run \`fastagent build\` in ${dir} first`);
  });
  const entry = (JSON.parse(manifest) as { exports: { ".": { default: string } } }).exports["."].default;
  return ((await import(pathToFileURL(join(dist, entry)).href)) as { default: AgentDefinition }).default;
}

try {
  const endpoint = process.env[ENDPOINT_ENV];
  if (!endpoint) throw new Error(`${ENDPOINT_ENV} is required: the Aurora DSQL cluster's endpoint`);
  const served = await serveAgentCore(await loadBuild(resolve(process.argv[2] ?? ".")), {
    database: dsqlDatabase({ endpoint }),
    secrets: process.env,
    env: baseEnv(process.env),
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      served.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(`[fastagent] stopping failed: ${String(error)}`);
          process.exit(1);
        },
      );
    });
  }
} catch (error) {
  console.error(`[fastagent] ${(error as Error)?.message ?? String(error)}`);
  process.exit(1);
}
