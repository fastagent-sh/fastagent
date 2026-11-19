/**
 * `fastagent agentcore <command>`: what an agent installing this package adds to the fastagent CLI.
 *   - `init` writes what `agentcore deploy` deploys: the agent's container and the AgentCore project (project.ts).
 *   - `start` is the container's command on AgentCore, as `fastagent start` is a container's elsewhere: it serves the
 *     build in `<agent>/dist`, with its instances in the Aurora DSQL cluster and its values in the Secrets Manager
 *     secret the runtime names (cdk.ts), read as each instance opens, over the runtime's own environment.
 *   - `invoke` sends one message to a deployed AgentCore runtime through `@fastagent-sh/client/agentcore` (loaded
 *     lazily so production images running `start` need no `@aws-sdk/client-bedrock-agentcore`).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Agent, SessionSettings } from "@fastagent-sh/client/agent-api";
import { baseEnv } from "@fastagent-sh/fastagent";
import {
  type ContainerTarget,
  type ExtensionCli,
  DATABASE_URL_ENV,
  agentFacts,
  invokeOverApi,
  loadAgentBuild,
  modelRefOf,
  readInvokeMessage,
  writeContainer,
} from "@fastagent-sh/fastagent/platform";
import type { PostgresDatabase } from "@fastagent-sh/fastagent";
import { createAlarmGroup } from "./alarms.ts";
import { dsqlDatabase } from "./dsql.ts";
import { AGENTCORE_CLI, projectName, writeProject } from "./project.ts";
import { serveAgentCore } from "./runtime.ts";
import { secretValues } from "./secrets.ts";
import {
  AGENTCORE_ARN_ENV,
  ALARM_GROUP_ENV,
  ALARM_INSTANCES_ENV,
  DSQL_ENDPOINT_ENV,
  SECRETS_ENV,
} from "./variables.ts";

const USAGE = `Usage: fastagent [-C <dir>] agentcore <command>

Commands:
  init    write the agent's container and its AgentCore project, for \`npx ${AGENTCORE_CLI} deploy\`
          --force: regenerate the container files fastagent generated; --no-install: skip npm install
  start   serve the agent's build on AgentCore's port: the container's command
  invoke  send one message to a deployed AgentCore runtime (positional, \`-\`, or piped stdin)
          --arn <arn>: runtime ARN (or ${AGENTCORE_ARN_ENV})
          --instance <id>: AgentCore session id, 33-256 chars (default: a fresh id)
          --session <id>: continue an Agent API session inside --instance
          --qualifier <name>: runtime endpoint name (default: DEFAULT)
          --model <provider/model>: model for this message
          --json: Agent API events as JSON lines on stdout`;

const AGENTCORE_AUTH_HINT = "check the agent's Secrets Manager secret and AWS credentials";

/** The container on AgentCore: its state in the platform's database, the AgentCore project left out of the image. */
const AGENTCORE_TARGET: ContainerTarget = {
  writtenBy: "fastagent deploy init agentcore",
  command: ["./node_modules/.bin/fastagent", "agentcore", "start"],
  storage: "database",
  port: 8080,
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
  if (!written.ok) throw new Error(`deploy init agentcore stopped: ${written.gate}`);
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (installed.stdout?.length) process.stderr.write(installed.stdout);
    if (installed.stderr?.length) process.stderr.write(installed.stderr);
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

async function loadAgentCoreClient() {
  try {
    return await import("@fastagent-sh/client/agentcore");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      usageError(
        "invoking AgentCore requires @aws-sdk/client-bedrock-agentcore: install it with `npm install @aws-sdk/client-bedrock-agentcore`",
      );
    }
    throw error;
  }
}

async function invoke(
  given: string | undefined,
  flags: {
    arn?: string;
    instance?: string;
    session?: string;
    qualifier?: string;
    model?: string;
    json?: boolean;
  },
): Promise<void> {
  const runtimeArn = (flags.arn ?? process.env[AGENTCORE_ARN_ENV])?.trim();
  if (!runtimeArn) usageError(`missing runtime ARN: pass --arn <arn> or set ${AGENTCORE_ARN_ENV}`);
  if (flags.session !== undefined && flags.instance === undefined) {
    usageError("--session requires --instance (which AgentCore instance owns that session)");
  }
  let settings: SessionSettings | undefined;
  try {
    settings = flags.model === undefined ? undefined : { model: modelRefOf(flags.model, "--model") };
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
  const instance = flags.instance ?? `cli-${randomUUID()}`;
  const { connectAgentCore } = await loadAgentCoreClient();
  let agent: Agent;
  try {
    agent = connectAgentCore({ runtimeArn, sessionId: instance, qualifier: flags.qualifier });
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
  const input = await readInvokeMessage(given, "fastagent agentcore invoke");
  if (!input.ok) usageError(input.error);
  const where =
    flags.qualifier === undefined
      ? `${runtimeArn} (instance ${instance})`
      : `${runtimeArn} (instance ${instance}, qualifier ${flags.qualifier})`;
  const exitCode = await invokeOverApi(agent, where, input.message, {
    session: flags.session,
    settings,
    json: flags.json,
    authHint: AGENTCORE_AUTH_HINT,
    continueFlags: (sessionId) => `--instance ${instance} --session ${sessionId}`,
  });
  process.exit(exitCode);
}

export const run: ExtensionCli["run"] = async (args) => {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({
      args: normalizeValueArgs(args),
      options: OPTIONS,
      allowPositionals: true,
      allowNegative: true,
    });
  } catch (error) {
    usageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...extra] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return;
  }
  const hasInitFlags = values.force !== undefined || values.install !== undefined;
  const hasInvokeFlags =
    values.arn !== undefined ||
    values.instance !== undefined ||
    values.session !== undefined ||
    values.qualifier !== undefined ||
    values.model !== undefined ||
    values.json !== undefined;
  if (command === "invoke") {
    if (extra.length > 1) usageError("invoke takes at most one <message> argument");
    if (hasInitFlags) usageError("--force and --no-install are init's");
    return invoke(extra[0], {
      arn: values.arn,
      instance: values.instance,
      session: values.session,
      qualifier: values.qualifier,
      model: values.model,
      json: values.json,
    });
  }
  if (extra.length > 0) usageError(`${command} takes no positional arguments (use \`fastagent -C <dir>\`)`);
  if (hasInvokeFlags) usageError("--arn, --instance, --session, --qualifier, --model, and --json are invoke's");
  const agentDir = resolve(".");
  if (command === "init") return init(agentDir, { force: values.force === true, install: values.install !== false });
  if (hasInitFlags) usageError("--force and --no-install are init's");
  if (command === "start") return start(agentDir);
  usageError(`unknown command '${command}'`);
};

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  force: { type: "boolean" },
  install: { type: "boolean" },
  arn: { type: "string" },
  instance: { type: "string" },
  session: { type: "string" },
  qualifier: { type: "string" },
  model: { type: "string" },
  json: { type: "boolean" },
} as const;

const VALUE_OPTIONS = new Set(["--arn", "--instance", "--session", "--qualifier", "--model"]);
const ALL_FLAGS = new Set([
  "-h",
  "--help",
  "--force",
  "--no-force",
  "--install",
  "--no-install",
  "--json",
  "--no-json",
  ...VALUE_OPTIONS,
]);

/**
 * Node's `parseArgs` rejects `--session -abc` when a base64url session id starts with `-`. Rewrite `<opt> <val>` into
 * `<opt>=<val>` when `<val>` starts with `-` and is not another known flag, matching commander's `--session` parsing.
 */
function normalizeValueArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      out.push(...args.slice(i));
      break;
    }
    const next = args[i + 1];
    if (VALUE_OPTIONS.has(arg) && next !== undefined && next.startsWith("-") && !ALL_FLAGS.has(next)) {
      out.push(`${arg}=${next}`);
      i++;
    } else {
      out.push(arg);
    }
  }
  return out;
}
