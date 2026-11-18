/**
 * `fastagent agentcore <command>`: what an agent installing this package adds to the fastagent CLI. `serve` is a
 * container's command on AgentCore: it serves the build in `<dir>/dist` (`fastagent build`), with its instances in the
 * Aurora DSQL cluster `FASTAGENT_DSQL_ENDPOINT` names, and the runtime's environment variables as the agent's secrets,
 * as `fastagent start` takes them.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentDefinition, type ExtensionCli, baseEnv } from "@fastagent-sh/fastagent";
import { dsqlDatabase } from "./dsql.ts";
import { serveAgentCore } from "./runtime.ts";

const ENDPOINT_ENV = "FASTAGENT_DSQL_ENDPOINT";

const USAGE = `Usage: fastagent agentcore <command>

Commands:
  serve [dir]  serve the agent's build on AgentCore's port: a container's command (dir: the agent, default .)`;

async function loadBuild(dir: string): Promise<AgentDefinition> {
  const dist = join(dir, "dist");
  const manifest = await readFile(join(dist, "package.json"), "utf8").catch(() => {
    throw new Error(`there is no build in ${dist}: run \`fastagent build\` in ${dir} first`);
  });
  const entry = (JSON.parse(manifest) as { exports: { ".": { default: string } } }).exports["."].default;
  return ((await import(pathToFileURL(join(dist, entry)).href)) as { default: AgentDefinition }).default;
}

async function serve(dir: string): Promise<void> {
  const endpoint = process.env[ENDPOINT_ENV];
  if (!endpoint) throw new Error(`${ENDPOINT_ENV} is required: the Aurora DSQL cluster's endpoint`);
  const served = await serveAgentCore(await loadBuild(resolve(dir)), {
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
}

export const run: ExtensionCli["run"] = async (args) => {
  const [command, ...rest] = args;
  if (command === "serve" && rest.length <= 1) return serve(rest[0] ?? ".");
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  console.error(
    command === "serve"
      ? `Error: serve takes one directory, and was given ${rest.length}\n\n${USAGE}`
      : `Error: unknown command '${command}'\n\n${USAGE}`,
  );
  process.exit(2);
};
