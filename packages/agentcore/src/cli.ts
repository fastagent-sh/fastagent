/**
 * `fastagent agentcore <command>`: what an agent installing this package adds to the fastagent CLI.
 *   - `init` writes what `agentcore deploy` deploys: the agent's container and the AgentCore project (project.ts).
 *   - `start` is the container's command on AgentCore, as `fastagent start` is a container's elsewhere: it serves the
 *     build in `<agent>/dist`, with its instances in the Aurora DSQL cluster and its values in the Secrets Manager
 *     secret the runtime names (cdk.ts), read as each instance opens, over the runtime's own environment.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { baseEnv } from "@fastagent-sh/fastagent";
import {
  type ContainerTarget,
  type ExtensionCli,
  DATABASE_URL_ENV,
  agentFacts,
  loadAgentBuild,
  writeContainer,
} from "@fastagent-sh/fastagent/platform";
import type { PostgresDatabase } from "@fastagent-sh/fastagent";
import { createAlarmGroup } from "./alarms.ts";
import { dsqlDatabase } from "./dsql.ts";
import { AGENTCORE_CLI, projectName, writeProject } from "./project.ts";
import { serveAgentCore } from "./runtime.ts";
import { secretValues } from "./secrets.ts";
import { ALARM_GROUP_ENV, ALARM_INSTANCES_ENV, DSQL_ENDPOINT_ENV, SECRETS_ENV } from "./variables.ts";

const USAGE = `Usage: fastagent agentcore <command> [agent]

Commands:
  init [agent]   write the agent's container and its AgentCore project, for \`npx ${AGENTCORE_CLI} deploy\`
                 --force: regenerate the container files fastagent generated; --no-install: skip npm install
  start [agent]  serve the agent's build on AgentCore's port: the container's command

[agent] is the agent directory, by default the current one.`;

/** The container on AgentCore: its state in the platform's database, the AgentCore project left out of the image. */
const AGENTCORE_TARGET: ContainerTarget = {
  writtenBy: "fastagent agentcore init",
  command: ["./node_modules/.bin/fastagent", "agentcore", "start", "/app"],
  storage: "database",
  ignore: ["agentcore"],
};

const OWN_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

function usageError(message: string): never {
  console.error(`Error: ${message}\n\n${USAGE}`);
  process.exit(2);
}

async function init(agentDir: string, flags: { force: boolean; install: boolean }): Promise<void> {
  const facts = await agentFacts(agentDir);
  const written = await writeContainer(agentDir, AGENTCORE_TARGET, { force: flags.force });
  if (!written.ok) throw new Error(`agentcore init stopped: ${written.gate}`);
  const wrote = await writeProject(agentDir, {
    project: projectName(facts.name),
    secret: facts.name,
    version: OWN_VERSION,
  });
  console.error(
    wrote
      ? "[fastagent] wrote agentcore/ (the AgentCore project: yours from now on)"
      : "[fastagent] kept agentcore/ (yours once written)",
  );
  if (wrote && flags.install) {
    const installed = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: join(agentDir, "agentcore", "cdk"),
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (installed.status !== 0) throw new Error("npm install in agentcore/cdk failed: run it there, then deploy");
  }
  const names = [...new Set(facts.secrets.filter((s) => !s.optional).map((s) => s.name))];
  const model =
    facts.model === undefined
      ? "and what its model signs in with"
      : `and what ${facts.model} signs in with: its provider's API key, as anywhere ` +
        `(\`fastagent login --check ${facts.model}\` says whether one is there)`;
  console.log(
    [
      `# In each AWS account you deploy to, create the secret ${facts.name}: a JSON object of the agent's values,`,
      `# ${names.length === 0 ? "none declared by its code" : `${names.join(", ")}, which its code declares`},`,
      `# ${model}.`,
      `aws secretsmanager create-secret --name ${facts.name} --secret-string file://<values.json>`,
      "# Then deploy, here or in CI:",
      `npx -y ${AGENTCORE_CLI} deploy`,
    ].join("\n"),
  );
}

function databaseOf(environment: NodeJS.ProcessEnv): PostgresDatabase {
  const endpoint = environment[DSQL_ENDPOINT_ENV];
  const url = environment[DATABASE_URL_ENV];
  if (endpoint) return dsqlDatabase({ endpoint });
  if (url) return { url };
  throw new Error(
    `${DSQL_ENDPOINT_ENV} is required: the Aurora DSQL cluster's endpoint (or ${DATABASE_URL_ENV}, a PostgreSQL ` +
      "database, to run the image off AWS)",
  );
}

async function start(agentDir: string): Promise<void> {
  const secretName = process.env[SECRETS_ENV];
  const alarmGroup = process.env[ALARM_GROUP_ENV];
  const alarmInstances = (process.env[ALARM_INSTANCES_ENV] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const served = await serveAgentCore(await loadAgentBuild(agentDir), {
    database: () => databaseOf(process.env),
    secrets: process.env,
    ...(secretName ? { values: () => secretValues(secretName, process.env) } : {}),
    ...(alarmGroup ? { alarms: createAlarmGroup({ group: alarmGroup, instances: alarmInstances }) } : {}),
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
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...args], options: OPTIONS, allowPositionals: true, allowNegative: true });
  } catch (error) {
    usageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, dir, ...extra] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return;
  }
  if (extra.length > 0) usageError(`${command} takes one agent directory, and was given ${extra.length + 1}`);
  const agentDir = resolve(dir ?? ".");
  if (command === "init") return init(agentDir, { force: values.force === true, install: values.install !== false });
  if (values.force !== undefined || values.install !== undefined) usageError(`--force and --no-install are init's`);
  if (command === "start") return start(agentDir);
  usageError(`unknown command '${command}'`);
};

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  force: { type: "boolean" },
  install: { type: "boolean" },
} as const;
